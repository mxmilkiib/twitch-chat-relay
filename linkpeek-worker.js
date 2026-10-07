// Link preview worker for hasanabi.neocities.org (Cloudflare Workers).
// GET /?url=<page> returns trimmed metadata as JSON:
//   { title, description, site, image, icon, color, author, published,
//     views, facts, video, ttl, url }
//   video = a directly playable mp4 (provider-resolved, eg reels)
//   url = final address after redirects
//   facts = provider-supplied fact chips (eg twitch live/followers/modes)
//   ttl   = seconds the provider wants this cached (volatile previews)
// Sources, best first: og:/twitter: tags, schema.org JSON-LD, then <title>
// and meta description; the page's own oEmbed endpoint fills any gap left
// in image, site, author or title. A non-html target still answers with
// its filename, content type and size, never its body.
// Callers are the chat relay iframe (github.io) and the page itself; both
// send an Origin header, which is required and checked against ALLOWED,
// and each ip gets 30 uncached lookups a minute per isolate.
// Hits cache for a day, misses for a minute. Only metadata ever leaves -
// a page is read up to the end of <head> (further, up to MAX_READ, only when
// the head carries no og:title or JSON-LD) and the rest is discarded.
const ALLOWED = ['https://mxmilkiib.github.io', 'https://hasanabi.neocities.org'];
const MAX_URL = 2048;
const MAX_HOPS = 4;
const MAX_READ = 128 * 1024;
const MAX_LD = 64 * 1024;
const TTL_OK = 86400;
const TTL_FAIL = 60;
const UA = 'hasan-linkpeek/1.0 (+https://hasanabi.neocities.org/)';

// 1823458356 -> '1.8B', 1234567 -> '1.2M', 42 -> '42'
const abbrev = (n) =>
  `${n >= 1e9 ? +(n / 1e9).toFixed(1) + 'B'
    : n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? Math.round(n / 1e3) + 'K'
    : n}`;
const fmtCount = (n) => `${abbrev(n)} views`;

// 'just now'..'2y 70d ago' for lastBroadcast stamps; long gaps read as
// months then years+days so an old stream doesn't say '742d ago'
const rel = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1e3);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  if (d < 45) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30.44)}mo ago`;
  const y = Math.floor(d / 365), rd = d - y * 365;
  return rd ? `${y}y ${rd}d ago` : `${y}y ago`;
};

const corsFor = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

const reply = (obj, origin, status = 200, ttl = TTL_OK) => new Response(JSON.stringify(obj), {
  status,
  headers: { ...corsFor(origin), 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
});

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16) || 63))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d || 63))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
// until stable (bounded): some sites stack encodings - twitch leaves a
// literal &#39; behind one pass, linktree &amp; behind two
const clean = (s, max) => {
  let v = String(s || '');
  for (let i = 0; i < 4; i++) { const d = decode(v); if (d === v) break; v = d; }
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
};

// refuse anything that isn't a public-looking hostname on a default port
function safeTarget(u) {
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.includes(':') || /^\d+(\.\d+){3}$/.test(h) || /^\d+$/.test(h.split('.').pop())) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|corp|invalid|test|example)$/.test(h);
}

// per-site providers: each returns { title, description, site, image } or null.
// a { partial: true, ... } result doesn't short-circuit the scrape - its
// fields merge over the page's own metadata (eg a resolved media file)
const getJson = (url, init) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(4000), ...init })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);

// youtube's public innertube client - the same unauthenticated endpoints
// the site itself calls; channel pages have no oembed and the consent
// wall can swallow the plain scrape, so they resolve here instead
const YT_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const ytApi = (ep, body) => fetch(`https://www.youtube.com/youtubei/v1/${ep}?key=${YT_KEY}`, {
  method: 'POST',
  signal: AbortSignal.timeout(4000),
  headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: '2.20241126.01.00' } },
    ...body,
  }),
}).then((r) => (r.ok ? r.json() : null)).catch(() => null);

const PROVIDERS = [
  [/^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/, async (u) => {
    // @handle, /channel/UC…, /c/name and /user/name pages resolve through
    // innertube to a browseId, then the browse answer carries the card
    const ch = u.hostname.endsWith('youtube.com') &&
      u.pathname.match(/^\/(?:@([\w.-]+)|channel\/(UC[\w-]+)|c\/([\w.-]+)|user\/([\w.-]+))/);
    if (ch) {
      let bid = ch[2];
      if (!bid) {
        const r = await ytApi('navigation/resolve_url', { url: u.href });
        bid = r && r.endpoint && r.endpoint.browseEndpoint && r.endpoint.browseEndpoint.browseId;
      }
      const b = bid && (await ytApi('browse', { browseId: bid }));
      const meta = b && b.metadata && b.metadata.channelMetadataRenderer;
      if (!meta) return null;
      const av = b.header && b.header.pageHeaderRenderer && b.header.pageHeaderRenderer.content &&
        b.header.pageHeaderRenderer.content.pageHeaderViewModel;
      const srcs = av && av.image && av.image.decoratedAvatarViewModel &&
        av.image.decoratedAvatarViewModel.avatar && av.image.decoratedAvatarViewModel.avatar.avatarViewModel &&
        av.image.decoratedAvatarViewModel.avatar.avatarViewModel.image &&
        av.image.decoratedAvatarViewModel.avatar.avatarViewModel.image.sources;
      const image = Array.isArray(srcs) && srcs.length ? srcs[srcs.length - 1].url : '';
      return { title: meta.title || '', description: meta.description || '', site: 'YouTube', image };
    }
    if (u.hostname.endsWith('youtube.com') && !/^\/(watch|shorts|live|playlist)/.test(u.pathname)) return null;
    const j = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.href)}`);
    const out = j && j.title ? { title: j.title, description: j.author_name ? `by ${j.author_name}` : '', site: 'YouTube', image: j.thumbnail_url } : null;
    // oembed carries no date or views - they sit in the watch page's
    // player json ~700KB in, scanned chunk-wise so the read stops early
    const vid = u.hostname === 'youtu.be' ? u.pathname.split('/')[1]
      : u.pathname === '/watch' ? u.searchParams.get('v')
      : (u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/) || [])[1];
    if (!vid) return out;
    const w = await fetchPage(new URL(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`)).catch(() => null);
    if (w && w.res.ok) {
      let views = '', pub = '';
      await readText(w.res, 900 * 1024, (all, fresh) => {
        if (!views) views = (/"viewCount":"(\d+)"/.exec(fresh) || [])[1] || '';
        if (!pub) pub = (/"(?:publish|upload)Date":"(\d{4}-\d\d-\d\d)/.exec(fresh) || [])[1] || '';
        return !!(views && pub);
      }).catch(() => '');
      if (out) { out.views = views; out.published = pub; }
      w.res.body && w.res.body.cancel().catch(() => {});
    }
    return out;
  }],
  [/^(?:www\.|old\.|np\.|m\.)?reddit\.com$|^redd\.it$/, async (u) => {
    // reddit serves a bare js shell to non-browser fetches, but its atom
    // feeds are still open: a post's .rss holds title/author/sub/body/date,
    // a sub or user feed holds a subtitle and the recent post titles
    let feed = '', post = false;
    if (u.hostname === 'redd.it') {
      const got = await fetchPage(new URL(`https://redd.it${u.pathname}`)).catch(() => null);
      if (!got || !got.res.ok) return null;
      got.res.body && got.res.body.cancel().catch(() => {});
      const cm = got.url.pathname.match(/^\/r\/[\w-]+\/comments\/[a-z0-9]+/i);
      if (cm) { feed = `https://www.reddit.com${cm[0]}`; post = true; }
    } else {
      const cm = u.pathname.match(/^\/(?:r\/[\w-]+\/)?comments\/[a-z0-9]+/i);
      const rm = u.pathname.match(/^\/(r|u|user)\/([\w-]+)/i);
      if (cm) { feed = 'https://www.reddit.com' + cm[0]; post = true; }
      else if (rm) feed = `https://www.reddit.com/${rm[1].toLowerCase() === 'u' ? 'user' : rm[1].toLowerCase()}/${rm[2]}`;
    }
    if (!feed) return null;
    const x = await fetch(feed + '.rss?limit=4', {
      headers: { 'User-Agent': UA, Accept: 'application/atom+xml,text/xml' },
      signal: AbortSignal.timeout(4000),
    }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    if (!x) return null;
    const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
    const entries = [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
    // a comment permalink carries a second id; its entry is t1_-tagged
    const cid = (u.pathname.match(/\/comments\/[a-z0-9]+\/[\w-]*\/([a-z0-9]+)/i) || [])[1];
    const entry = post && ((cid && entries.find((e) => e.includes(`<id>t1_${cid}</id>`))) || entries[0]);
    const feedTitle = tag(x, 'title');
    if (entry) {
      // content holds entity-escaped html - decode first so the tag strip
      // and image scrape see real markup
      const dec = clean(tag(entry, 'content'), 8000);
      const img = (dec.match(/<img[^>]+src="([^" ]+)/i) || [])[1] || '';
      const body = clean(dec
        .replace(/<!--[\s\S]*?-->|<[^>]+>/g, ' ')
        .replace(/\s*(?:submitted by|\[link\])[\s\S]*/i, ''), 280);
      return {
        title: clean(tag(entry, 'title'), 200), description: body,
        author: clean(tag(entry, 'name').replace(/^\//, '')),
        published: tag(entry, 'published'), site: 'Reddit', image: img,
      };
    }
    if (!feedTitle) return null;
    return {
      title: clean(feedTitle, 120), site: 'Reddit',
      description: clean(tag(x, 'subtitle'), 200) || `on Reddit`,
      facts: entries.map((e) => clean(tag(e, 'title'), 80)).filter(Boolean).slice(0, 4),
    };
  }],
  [/^(?:www\.)?github\.com$/, async (u) => {
    const [owner, repo] = u.pathname.split('/').filter(Boolean);
    if (!owner || !repo || /^(orgs|sponsors|topics|settings|marketplace|features)$/.test(owner)) return null;
    const j = await getJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return j && j.full_name ? {
      title: j.full_name,
      description: [j.description, j.stargazers_count != null ? `${j.stargazers_count.toLocaleString('en')} star${j.stargazers_count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
      site: 'GitHub', image: j.owner && j.owner.avatar_url,
    } : null;
  }],
  [/^([a-z-]+)\.wikipedia\.org$/, async (u, m) => {
    const t = u.pathname.match(/^\/wiki\/([^/]+)/);
    if (!t) return null;
    const j = await getJson(`https://${m[1]}.wikipedia.org/api/rest_v1/page/summary/${t[1]}`);
    return j && j.title ? { title: j.title, description: j.extract, site: 'Wikipedia', image: j.thumbnail && j.thumbnail.source } : null;
  }],
  // HN refuses datacentre fetches; the official firebase api stays open
  [/^news\.ycombinator\.com$/, async (u) => {
    const id = u.searchParams.get('id');
    if (u.pathname !== '/item' || !/^\d+$/.test(id || '')) return null;
    const j = await getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    if (!j || !j.title) return null;
    let host = '';
    try { host = j.url ? new URL(j.url).hostname.replace(/^www\./, '') : ''; } catch { /* no linked article */ }
    return {
      title: j.title, site: 'Hacker News', author: j.by,
      description: [`${j.score ?? 0} points`, j.descendants != null ? `${j.descendants} comments` : '', host].filter(Boolean).join(' · '),
      published: j.time ? new Date(j.time * 1000).toISOString() : '',
      icon: 'https://news.ycombinator.com/y18.svg',
    };
  }],
  [/^(?:www\.|clips\.)?twitch\.tv$/, async (u) => {
    // clip links - /<login>/clip/<slug> or clips.twitch.tv/<slug> - go
    // through gql with the public web client-id; the clip page's own
    // og tags are just the generic "Twitch" boilerplate
    const slug = (u.pathname.match(/^\/[\w]+\/clip\/([\w-]+)/i) || [])[1] ||
      (u.hostname.startsWith('clips.') ? (u.pathname.match(/^\/([\w-]+)/i) || [])[1] : null);
    if (slug) {
      const j = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query:
          `{ clip(slug: "${slug.replace(/[^\w-]/g, '')}") { title broadcaster { displayName } game { name } viewCount durationSeconds createdAt thumbnailURL curator { displayName } } }` }),
        signal: AbortSignal.timeout(6000),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const c = j && j.data && j.data.clip;
      if (!c || !c.title) return { partial: true };
      const cf = [];
      if (c.viewCount != null) cf.push(`${abbrev(c.viewCount)} views`);
      if (c.durationSeconds) cf.push(`${c.durationSeconds}s`);
      if (c.game && c.game.name) cf.push(c.game.name);
      if (c.createdAt) cf.push(rel(Date.parse(c.createdAt)));
      return {
        title: c.title, site: 'Twitch clip',
        author: c.curator && c.curator.displayName ? `clipped by ${c.curator.displayName}` : null,
        description: c.broadcaster ? c.broadcaster.displayName : '',
        image: c.thumbnailURL, facts: cf, ttl: 0,
      };
    }
    const login = (u.pathname.match(/^\/([a-z0-9_]{2,25})\/?$/i) || [])[1];
    if (!login || /^(directory|videos|settings|downloads|jobs|turbo|store|p)$/i.test(login)) return null;
    const j = await getJson(`https://api.ivr.fi/v2/twitch/user?login=${login}`);
    const user = Array.isArray(j) ? j[0] : j;
    if (!user || !user.displayName) return null;
    // the ivr.fi payload is rich - surface the bits a chatter cares
    // about as fact chips: live state, reach, age, standing, chat modes
    const facts = [], st = user.stream;
    if (st) facts.push(`live · ${abbrev(st.viewersCount || 0)} watching${st.game ? ' · ' + st.game.displayName : ''}`);
    else if (user.lastBroadcast && user.lastBroadcast.startedAt)
      facts.push(`last live ${rel(Date.parse(user.lastBroadcast.startedAt))}`);
    if (user.followers != null) facts.push(`${abbrev(user.followers)} followers`);
    if (user.chatterCount > 0) facts.push(`${abbrev(user.chatterCount)} chatting`);
    if (user.createdAt) facts.push(`joined ${user.createdAt.slice(0, 7)}`);
    const r = user.roles || {};
    if (user.banned) facts.push('banned');
    else {
      if (r.isPartner) facts.push('partner'); else if (r.isAffiliate) facts.push('affiliate');
      if (r.isStaff) facts.push('staff');
      if (user.verifiedBot) facts.push('verified bot');
    }
    const cs = user.chatSettings || {};
    if (cs.followersOnlyDurationMinutes)
      facts.push(`followers only ${cs.followersOnlyDurationMinutes >= 60 ? Math.round(cs.followersOnlyDurationMinutes / 60) + 'h' : cs.followersOnlyDurationMinutes + 'm'}`);
    if (cs.isSubscribersOnlyModeEnabled) facts.push('subs only');
    if (cs.isEmoteOnlyModeEnabled) facts.push('emote only');
    if (cs.isFastSubsModeEnabled) facts.push('fast subs only');
    if (cs.isUniqueChatModeEnabled) facts.push('unique chat');
    if (cs.requireVerifiedAccount) facts.push('verified acct');
    if (cs.slowModeDurationSeconds) facts.push(`slow ${cs.slowModeDurationSeconds}s`);
    if (cs.chatDelayMs) facts.push(`${cs.chatDelayMs / 1e3}s delay`);
    if (cs.blockLinks) facts.push('links blocked');
    return {
      title: user.displayName,
      description: [st && st.title, user.bio].filter(Boolean).join(' — '),
      site: 'Twitch', image: user.logo, color: user.chatColor,
      facts, ttl: st ? 300 : 0,
    };
  }],
  // instagram's own page carries og:title/poster/caption; the playable
  // file is fetched through kkclip (kkscript), which 302s a bot ua to
  // the signed cdn mp4. the provider only adds video + a short ttl (the
  // signature rots in ~a day) - a kkclip outage loses just the playback
  [/^(?:www\.)?instagram\.com$/, async (u) => {
    const id = (u.pathname.match(/^\/(?:reels?|p|tv)\/([\w-]{5,20})/i) || [])[1];
    if (!id) return null;
    const res = await fetch(`https://www.kkclip.com/reel/${id}/`, {
      redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
    }).catch(() => null);
    if (!res) return { partial: true };
    res.body && res.body.cancel().catch(() => {});
    let video = null;
    const loc = res.headers.get('location') || '';
    if (res.status >= 300 && res.status < 400) {
      try {
        const v = new URL(loc);
        if (v.protocol === 'https:' && /(^|\.)cdninstagram\.com$/.test(v.hostname)) video = v.href;
      } catch { /* not a media redirect */ }
    }
    return { partial: true, video, ttl: video ? 21600 : 0 };
  }],
  // imgur never emits og:title (the post title is client-rendered) and
  // its html/api are geo-blocked in some regions. the v3 api answers
  // anonymously with a client-id header where the egress allows it, and
  // jina's reader renders the post server-side otherwise - its title
  // field holds "… - <topic> post" for gallery slugs while classic short
  // links carry the title just above the [MORE TAGS] self-link in the
  // markdown. a total miss still lands an image thumbnail card
  [/^(?:i\.|www\.|m\.)?imgur\.com$/, async (u) => {
    const id = (u.hostname === 'i.imgur.com'
      ? u.pathname.match(/^\/([\w-]{5,9})\.\w{2,4}$/)
      : u.pathname.match(/^\/([\w-]{5,9})$/) || u.pathname.match(/^\/(?:a|gallery|g)\/([\w-]+)/i) || [])[1];
    if (!id || /^(?:topics?|t|search|about|tos|privacy|jobs|advertise|help|rules|contact|register|signin|removalrequest|uploads?|blog)$/i.test(id)) return null;
    // slugged gallery urls end in the media id (abc-def-XYZ1234); plain
    // post and album links carry it whole
    const mid = (id.match(/([A-Za-z0-9]+)$/) || [0, id])[1];
    const img = u.hostname === 'i.imgur.com' ? u.origin + u.pathname : `https://i.imgur.com/${mid}.png`;
    const kinds = /^\/(?:a|gallery|g)\//i.test(u.pathname) ? ['gallery', 'album'] : ['image', 'gallery'];
    for (const kind of kinds) {
      const res = await fetch(`https://api.imgur.com/3/${kind}/${mid}`, {
        signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Client-ID 546c25a59c58ad7' },
      }).catch(() => null);
      if (!res) continue;
      if (!res.ok) { res.body && res.body.cancel().catch(() => {}); continue; }
      const j = await res.json().catch(() => null);
      if (j && j.success && j.data) {
        const d = j.data;
        const media = (d.images && d.images[0] && d.images[0].link) || d.link;
        return { title: d.title, ogDesc: d.description, site: 'Imgur', image: media || img,
          author: d.account_url, published: d.datetime ? new Date(d.datetime * 1000).toISOString() : null,
          views: d.views, facts: d.images && d.images.length > 1 ? [`${d.images.length} images`] : null };
      }
    }
    let title = null;
    const pg = u.hostname === 'i.imgur.com' ? `https://imgur.com/${mid}` : u.origin + u.pathname;
    const jr = await fetch(`https://r.jina.ai/${pg}`, {
      signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' },
    }).catch(() => null);
    if (jr && jr.ok) {
      const d = (await jr.json().catch(() => null))?.data;
      if (d) {
        // gallery slugs: "… - gaming post"; strips just the topic suffix
        const jt = (d.title || '').replace(/\s+-\s+[^-]{1,40}?\s+post\s*$/i, '').trim();
        if (jt && !/^(imgur|the magic of the internet|content not available)/i.test(jt)) title = jt;
        else {
          // classic posts: bare title line above "[MORE TAGS +](<post url>)"
          const mt = (d.content || '').match(/\n\n([^\n\[][^\n]{1,280})\n\n\[MORE TAGS \+\]/);
          if (mt) title = mt[1].trim();
        }
      }
    }
    return { title: title || decodeURIComponent((u.pathname.match(/\/([\w.-]+)$/) || [])[1] || id),
      site: 'Imgur', image: img };
  }],
];

class MetaGrab {
  constructor(out) { this.out = out; }
  element(el) {
    const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
    const val = el.getAttribute('content') || '';
    if (!val.trim()) return;
    const o = this.out;
    if (key === 'og:title' || key === 'twitter:title') o.title ||= val;
    else if (key === 'og:description' || key === 'twitter:description') o.ogDesc ||= val;
    else if (key === 'description') o.desc ||= val;
    else if (key === 'og:site_name' || key === 'application-name') o.site ||= val;
    else if (key === 'og:image' || key === 'og:image:url' || key === 'twitter:image' || key === 'twitter:image:src') o.image ||= val;
    else if (key === 'theme-color') o.color ||= val;
    else if (key === 'author' || (key === 'article:author' && !/^https?:/i.test(val))) o.author ||= val;
    else if (key === 'article:published_time') o.published ||= val;
  }
}

// <link> tags: the page's oEmbed endpoint and its icons
class LinkGrab {
  constructor(out) { this.out = out; }
  element(el) {
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const href = el.getAttribute('href');
    if (!href) return;
    const o = this.out;
    if (rel.includes('alternate') && /json\+oembed/i.test(el.getAttribute('type') || '')) o.oembed ||= href;
    else if (rel.includes('icon')) o.icon ||= href;
    else if (rel.includes('apple-touch-icon')) o.touch ||= href;
  }
}

// schema.org JSON-LD blocks, collected per script and capped overall
class LdGrab {
  constructor(list) { this.list = list; this.size = 0; }
  element() { this.list.push(''); }
  text(t) {
    if (this.size > MAX_LD || !this.list.length) return;
    this.size += t.text.length;
    this.list[this.list.length - 1] += t.text;
  }
}

const LD_RICH = /Article|Posting|Product|Video|Recipe|Event|Movie|Book|Podcast|Course|Software/;
const ldType = (n) => [].concat(n['@type'] || []).join(' ');
const ldName = (v) => (!v ? '' : typeof v === 'string' ? v : Array.isArray(v) ? ldName(v[0]) : typeof v.name === 'string' ? v.name : '');
const ldImage = (v) => (!v ? '' : typeof v === 'string' ? v : Array.isArray(v) ? ldImage(v[0]) : typeof v.url === 'string' ? v.url : '');
const ldStr = (v) => (typeof v === 'string' ? v : '');

// the most descriptive node across every block, walking @graph wrappers
function pickLd(scripts) {
  const nodes = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    nodes.push(n);
    if (n['@graph']) walk(n['@graph']);
  };
  for (const s of scripts) { try { walk(JSON.parse(s)); } catch { /* malformed block */ } }
  return nodes.find((n) => LD_RICH.test(ldType(n)))
    || nodes.find((n) => /WebPage|WebSite|Organization/.test(ldType(n))) || null;
}

// the page's advertised oEmbed endpoint, vetted like any other target
async function fetchOembed(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'https:' || !safeTarget(u)) return null;
  try {
    const res = await fetch(u.href, { redirect: 'manual', signal: AbortSignal.timeout(4000), headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok || !/json/i.test(res.headers.get('content-type') || '')) return null;
    return JSON.parse(await readText(res, 64 * 1024));
  } catch { return null; }
}

// follows redirects by hand so every hop is vetted, not just the first
async function fetchPage(first) {
  let u = first;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!safeTarget(u)) return null;
    // YouTube bounces unknown agents to its consent interstitial in some
    // regions - a SOCS cookie answers it upfront and keeps the real page
    const yt = /(^|\.)youtube\.com$/.test(u.hostname);
    const res = await fetch(u.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml',
        ...(yt ? { Cookie: 'SOCS=CAE' } : {}) },
    });
    const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!loc) return { res, url: u };
    try { u = new URL(loc, u); } catch { return null; }
  }
  return null;
}

// streams a body as text up to `max` bytes, or until stop(all, fresh) says
// so, then cancels the rest
async function readText(res, max, stop) {
  const type = res.headers.get('content-type') || '';
  let dec;
  try { dec = new TextDecoder((type.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8'); } catch { dec = new TextDecoder(); }
  const reader = res.body.getReader();
  let text = '', bytes = 0, prev = '';
  while (bytes < max) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    const fresh = dec.decode(value, { stream: true });
    text += fresh;
    // the closing tag may straddle two chunks, so the test sees the seam
    if (stop && stop(text, prev + fresh)) break;
    prev = fresh.slice(-16);
  }
  reader.cancel().catch(() => {});
  return text;
}

// ends at </head>, unless the head held no og:title or JSON-LD - then the
// body may still carry a JSON-LD block, so reading runs on to MAX_READ
function headStop() {
  let headDone = false;
  return (all, fresh) => {
    if (!headDone && /<\/head>/i.test(fresh)) headDone = true;
    return headDone && /og:title|ld\+json/i.test(all);
  };
}

async function peek(first) {
  let extra = null;
  for (const [host, fn] of PROVIDERS) {
    const m = first.hostname.toLowerCase().match(host);
    if (!m) continue;
    const r = await fn(first, m).catch(() => null);
    if (r && r.partial) { extra = r; break; }
    if (r) return { ...r, url: first.href };
  }
  const got = await fetchPage(first);
  if (!got) return extra && extra.video
    ? { video: extra.video, ttl: extra.ttl, url: first.href } : null;
  const { res, url } = got;
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // a non-html target still gets a card: its filename, type and size
  if (res.ok && ctype && !/^text\/html|application\/xhtml/.test(ctype)) {
    res.body && res.body.cancel().catch(() => {});
    const label = {
      'application/pdf': 'PDF', 'application/zip': 'zip archive', 'application/gzip': 'gzip archive',
      'application/json': 'JSON', 'text/plain': 'plain text', 'text/markdown': 'markdown', 'text/csv': 'csv',
    }[ctype] || (ctype.startsWith('image/') ? 'image' : ctype.startsWith('video/') ? 'video'
      : ctype.startsWith('audio/') ? 'audio' : ctype);
    const len = +res.headers.get('content-length') || 0;
    const size = len ? ` · ${len >= 1e6 ? (len / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(len / 1e3)) + ' KB'}` : '';
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
    return { title: name, description: label + size, site: url.hostname, url: url.href };
  }
  if (!res.ok || !/^text\/html|application\/xhtml/.test(ctype)) return null;
  const meta = {};
  const lds = [];
  const head = await readText(res, MAX_READ, headStop()).catch(() => '');
  await new HTMLRewriter()
    .on('title', { text(t) { meta.rawTitle = (meta.rawTitle || '') + t.text; } })
    .on('meta', new MetaGrab(meta))
    .on('link', new LinkGrab(meta))
    .on('script[type="application/ld+json" i]', new LdGrab(lds))
    .transform(new Response(head, { headers: { 'content-type': 'text/html' } }))
    .text();

  // JSON-LD sits between og: tags and the bare <title>/description
  const ld = pickLd(lds);
  if (ld) {
    meta.ldTitle = ldStr(ld.headline) || ldName(ld.name) || ldStr(ld.name);
    meta.ldDesc = ldStr(ld.description);
    meta.image ||= ldImage(ld.image);
    meta.site ||= ldName(ld.publisher);
    meta.author ||= ldName(ld.author);
    meta.published ||= ldStr(ld.datePublished);
  }
  // the page's own oEmbed endpoint only fills what is still missing
  if (meta.oembed && (!meta.image || !(meta.title || meta.ldTitle) || !(meta.ogDesc || meta.ldDesc || meta.desc))) {
    const oe = await fetchOembed(meta.oembed, url);
    if (oe && typeof oe === 'object') {
      if (!meta.ldTitle && !meta.rawTitle) meta.title ||= ldStr(oe.title);
      meta.image ||= ldStr(oe.thumbnail_url);
      meta.site ||= ldStr(oe.provider_name);
      meta.author ||= ldStr(oe.author_name);
    }
  }
  // a partial provider's resolved fields ride on top of the scraped meta
  if (extra) { if (extra.video) meta.video = extra.video; if (extra.ttl) meta.ttl = extra.ttl; }
  return { ...meta, url: url.href };
}

// best-effort per-ip throttle: isolate-local, so it only damps casual
// abuse - a real waf rule needs a custom domain, which workers.dev can't
// hold. counted after the cache check so hits stay free
const ipHits = new Map(); // ip -> { t: window start, n: count }
function ipOk(ip) {
  if (!ip) return true;
  const now = Date.now();
  let e = ipHits.get(ip);
  if (!e || now - e.t > 6e4) { e = { t: now, n: 0 }; ipHits.set(ip, e); }
  if (ipHits.size > 5000) ipHits.clear();
  return ++e.n <= 30;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED.includes(origin)) return new Response('forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(origin) });
    if (request.method !== 'GET') return reply({ error: 'method not allowed' }, origin, 405, TTL_FAIL);

    const self = new URL(request.url);
    const raw = self.searchParams.get('url') || '';
    let target;
    try { target = new URL(raw); } catch { return reply({ error: 'bad url' }, origin, 400, TTL_FAIL); }
    if (raw.length > MAX_URL || !safeTarget(target)) return reply({ error: 'bad url' }, origin, 400, TTL_FAIL);
    target.hash = '';

    // the key ignores the caller's origin and query order
    const key = new Request(`${self.origin}/?url=${encodeURIComponent(target.href)}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { status: hit.status, headers: {
      ...corsFor(origin), 'Content-Type': 'application/json', 'Cache-Control': hit.headers.get('Cache-Control') || '' } });

    if (!ipOk(request.headers.get('CF-Connecting-IP')))
      return reply({ error: 'rate limited' }, origin, 429, TTL_FAIL);
    let found = null;
    try { found = await peek(target); } catch { found = null; }
    // relative and http: addresses resolve against the page; only https survives
    const abs = (v, max = 1000) => {
      if (!v) return null;
      try { const i = new URL(clean(v, max), found.url); return i.protocol === 'https:' ? i.href : null; } catch { return null; }
    };
    // boilerplate og titles ('Home', 'Index', an echo of site_name)
    // lose to the page's real <title> or its JSON-LD name
    const genericT = (t) => !t || /^(home|index|welcome|main|default|untitled)$/i.test(t.trim()) ||
      (found && found.site && t.trim().toLowerCase() === found.site.trim().toLowerCase());
    const title = found &&
      ((!genericT(found.title) && found.title) ||
       (!genericT(found.ldTitle) && found.ldTitle) ||
       (!genericT(found.rawTitle) && found.rawTitle) ||
       found.title || found.ldTitle || found.rawTitle);
    const desc = found && (found.ogDesc || found.ldDesc || found.desc || found.description);
    const body = found && (title || desc || found.video) ? {
      title: clean(title, 200) || null,
      description: clean(desc, 480) || null,
      site: clean(found.site, 80) || target.hostname,
      image: abs(found.image),
      icon: abs(found.icon || found.touch),
      color: /^#[0-9a-f]{3,8}$/i.test(found.color || '') ? found.color : null,
      author: clean(found.author, 80) || null,
      published: Number.isNaN(Date.parse(found.published)) ? null : new Date(found.published).toISOString().slice(0, 10),
      views: /^\d+$/.test(found.views || '') ? fmtCount(+found.views) : null,
      facts: Array.isArray(found.facts)
        ? found.facts.map((f) => clean(f, 80)).filter(Boolean).slice(0, 8) : null,
      // providers flag volatile previews (eg a live stream) with a
      // shorter ttl - echoed so the client cache honours it too
      ttl: found.ttl > 0 ? Math.min(found.ttl, TTL_OK) : null,
      video: abs(found.video, 2048),
      url: found.url,
    } : { error: 'no preview', url: found ? found.url : target.href };
    const out = reply(body, origin, 200, body.error ? TTL_FAIL : (body.ttl || TTL_OK));
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
