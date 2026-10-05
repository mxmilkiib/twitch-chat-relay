# twitch-chat-relay

A single-file Twitch chat relay hosted on GitHub Pages, designed to be
embedded as a hidden iframe by pages whose Content Security Policy forbids
outbound connections (e.g. Neocities' `connect-src 'self' data: blob:`).
GitHub Pages sends no CSP, so the WebSocket to Twitch works here, and
everything is forwarded to the embedder via `postMessage`.

Channel-agnostic: the channel comes from the embedder's `join` message —
any page on any host can use it for any Twitch channel, one channel per
iframe instance.

Single file: `index.html`. Companion frontend:
[HasanAbi Chat Thing](https://github.com/mxmilkiib/hasanabi.neocities.org).

## Usage

```html
<iframe src="https://mxmilkiib.github.io/twitch-chat-relay/" hidden></iframe>
```

```js
iframe.contentWindow.postMessage({ type: 'join', channel: 'somechannel' },
                                 'https://mxmilkiib.github.io');
```

## Protocol

Parent → relay: `{type: 'join', channel}`, `{type: 'backfill'}` —
backfill fetches the recent backlog from recent-messages.robotty.de and
returns it as `lines` for the embedder to dedup — `{type: 'tweet', id}`
for a tweet preview, and `{type: 'linkpeek', id, url}` for a generic
link preview via the embedder's Cloudflare worker.

Optional authenticated mode:

- `{type: 'auth', token}` — a chat-scoped user token (Twitch implicit
  OAuth grant). The relay validates it at `id.twitch.tv/oauth2/validate`,
  replies `{type: 'auth', login}` (or `{type: 'auth', error}`), and
  reconnects the socket with `PASS oauth:`/`NICK <login>` instead of the
  anonymous justinfan account. `token: null` logs out and drops back to
  anonymous.
- `{type: 'send', text, replyTo}` — once authenticated, sends
  `PRIVMSG #<channel> :<text>` on the same socket; `replyTo` (`{id,
  login}`) attaches a `reply-parent-msg-id` tag. Twitch replies with a
  `NOTICE` line on rejections (slow mode, followers-only, etc.), which
  flows through `lines` like everything else.

Relay → parent:

- `{type: 'status', state}` — connecting / connected / reconnecting
- `{type: 'lines', lines[]}` — raw Twitch IRC lines (tags + commands
  capabilities requested, PING/RECONNECT handled, exponential backoff)
- `{type: 'stream', uptime, viewers, title}` — from
  [DecAPI](https://decapi.me), polled every 60s
- `{type: 'emotes', emotes, emoteSrc, zeroWidth, badges, lastBroadcast,
  lastVod, emoteUse, emoteAnim}` — name → CDN URL map merged from 7TV,
  BTTV, FFZ and animated FFZ (globals + channel sets), per-emote source
  labels, 7TV zero-width names, badge `set → version → image` maps from
  [ivr.fi](https://api.ivr.fi), per-emote channel usage counts from
  [StreamElements chatstats](https://api.streamelements.com/kappa/v2/chatstats/),
  `emoteAnim` names the animated subset (7TV `data.animated`, BTTV
  `animated`/`imageType`, FFZ `animated` urls), plus stream history:
  `lastBroadcast` and the latest VOD's start/end from Twitch's public
  GraphQL endpoint
- `{type: 'nitter', host}` — fastest healthy nitter instance scraped
  from [status.d420.de](https://status.d420.de/), rechecked every 15 min
- `{type: 'auth', login, scopes}` or `{type: 'auth', error}` — result of
  an `auth` request (see above)
- `{type: 'wscause', code, reason}` — why the Twitch socket last closed,
  sent alongside each `reconnecting` status
- `{type: 'tweet', id, tweet}` — preview data (text, author, photo and
  video thumbnails, quoted-tweet media) for a status id the embedder
  requested with `{type: 'tweet', id}`, fetched from api.fxtwitter.com
- `{type: 'linkpeek', id, url, peek}` — page metadata (title,
  description, site, image, icon, color, author, published, views,
  facts, video, ttl, final url). `video` is a directly playable file —
  instagram reels resolve one through kkclip (kkscript), which 302s a
  bot UA to the signed CDN mp4; the card stays metadata-only if that
  service is down
  for a url the embedder requested
  with `{type: 'linkpeek', id, url}`; `peek` is null on failure. The
  relay calls the embedder's Cloudflare worker
  (hasanabi-chat-thing-linkpeek) — the worker does the scrape, so the
  relay itself never proxies arbitrary page bodies
- `{type: 'repo', stars, created, pushed}` — GitHub metadata for the
  embedder's repo, for its help panel

The relay holds the token only in memory — it isn't stored or forwarded
anywhere except the Twitch socket. (The embedder may persist it locally;
on this page it lives in localStorage until logout.)

## Link preview worker

`linkpeek-worker.js` is the Cloudflare Worker behind `{type: 'linkpeek'}`
(paste it into the worker's editor and deploy; it is not served from
this repo). It answers only the relay and embedder origins listed in
`ALLOWED`, vets every redirect hop, reads each page up to the end of
`<head>` (further, to 128 KB, when the head has no og:title or JSON-LD),
and has dedicated lookups for YouTube, GitHub, Wikipedia, Hacker News
items (via the official firebase api - HN itself refuses datacentre
fetches) and Twitch channel links. Twitch answers carry extra fact
chips from ivr.fi - live status, followers, chatters, account age,
role, and the channel's chat modes - and flag a short ttl while the
streamer is live so the cards refresh. The YouTube lookup also streams the
watch page far enough to pull the upload date and view count out of its
embedded player json, since oEmbed carries neither. For other pages it merges og/twitter tags, schema.org
JSON-LD, `<title>`/description, the page's advertised oEmbed endpoint,
its icon and theme-color, and any author and publish date. Hits cache
for a day.

## Deploy

Push to `main`; GitHub Pages serves it.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
