// Link preview worker for hasanabi.neocities.org (Cloudflare Workers).
// GET /?url=<page> returns trimmed metadata as JSON:
//   { title, description, site, image, url }   url = final address after redirects
// Callers are the chat relay iframe (github.io) and the page itself; both
// send an Origin header, which is required and checked against ALLOWED.
// Hits cache for a day, misses for a minute. Only metadata ever leaves -
// target bodies are read up to the end of <head> and discarded.
const ALLOWED = ['https://mxmilkiib.github.io', 'https://hasanabi.neocities.org'];
const MAX_URL = 2048;
const MAX_HOPS = 4;
const MAX_HEAD = 96 * 1024;
const TTL_OK = 86400;
const TTL_FAIL = 60;
const UA = 'hasan-linkpeek/1.0 (+https://hasanabi.neocities.org/)';

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
const clean = (s, max) => decode(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, max);

// refuse anything that isn't a public-looking hostname on a default port
function safeTarget(u) {
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.includes(':') || /^\d+(\.\d+){3}$/.test(h) || /^\d+$/.test(h.split('.').pop())) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|corp|invalid|test|example)$/.test(h);
}

// per-site providers: each returns { title, description, site, image } or null
const getJson = (url, init) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(4000), ...init })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);

const PROVIDERS = [
  [/^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/, async (u) => {
    if (u.hostname.endsWith('youtube.com') && !/^\/(watch|shorts|live|playlist)/.test(u.pathname)) return null;
    const j = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.href)}`);
    return j && j.title ? { title: j.title, description: j.author_name ? `by ${j.author_name}` : '', site: 'YouTube', image: j.thumbnail_url } : null;
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
  [/^(?:www\.)?twitch\.tv$/, async (u) => {
    const login = (u.pathname.match(/^\/([a-z0-9_]{2,25})\/?$/i) || [])[1];
    if (!login || /^(directory|videos|settings|downloads|jobs|turbo|store|p)$/i.test(login)) return null;
    const j = await getJson(`https://api.ivr.fi/v2/twitch/user?login=${login}`);
    const user = Array.isArray(j) ? j[0] : j;
    return user && user.displayName ? { title: user.displayName, description: user.bio, site: 'Twitch', image: user.logo } : null;
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
  }
}

// follows redirects by hand so every hop is vetted, not just the first
async function fetchPage(first) {
  let u = first;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!safeTarget(u)) return null;
    const res = await fetch(u.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!loc) return { res, url: u };
    try { u = new URL(loc, u); } catch { return null; }
  }
  return null;
}

// reads up to the end of <head> (or MAX_HEAD bytes) and drops the rest
async function readHead(res) {
  const type = res.headers.get('content-type') || '';
  let dec;
  try { dec = new TextDecoder((type.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8'); } catch { dec = new TextDecoder(); }
  const reader = res.body.getReader();
  let html = '', bytes = 0;
  while (bytes < MAX_HEAD) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return html;
}

async function peek(first) {
  for (const [host, fn] of PROVIDERS) {
    const m = first.hostname.toLowerCase().match(host);
    if (!m) continue;
    const r = await fn(first, m).catch(() => null);
    if (r) return { ...r, url: first.href };
  }
  const got = await fetchPage(first);
  if (!got) return null;
  const { res, url } = got;
  if (!res.ok || !/text\/html|xhtml/i.test(res.headers.get('content-type') || '')) return null;
  const meta = {};
  const head = await readHead(res).catch(() => '');
  await new HTMLRewriter()
    .on('title', { text(t) { meta.rawTitle = (meta.rawTitle || '') + t.text; } })
    .on('meta', new MetaGrab(meta))
    .transform(new Response(head, { headers: { 'content-type': 'text/html' } }))
    .text();
  return { ...meta, url: url.href };
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
    if (hit) return new Response(hit.body, { status: hit.status, headers: { ...Object.fromEntries(hit.headers), ...corsFor(origin) } });

    let found = null;
    try { found = await peek(target); } catch { found = null; }
    const body = found && (found.title || found.rawTitle || found.ogDesc || found.desc) ? {
      title: clean(found.title || found.rawTitle, 200) || null,
      description: clean(found.ogDesc || found.desc || found.description, 300) || null,
      site: clean(found.site, 80) || target.hostname,
      image: found.image ? (() => { try { const i = new URL(clean(found.image, 1000), found.url); return i.protocol === 'https:' ? i.href : null; } catch { return null; } })() : null,
      url: found.url,
    } : { error: 'no preview', url: found ? found.url : target.href };
    const out = reply(body, origin, 200, body.error ? TTL_FAIL : TTL_OK);
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
