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

For a status-only check, embed `live.html` instead and send
`{type: 'streamprobe', channels: ['somechannel']}`. It answers with the
same `stream` message without joining chat.

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
- `{type: 'nitter', host}` — a nitter instance verified live through the
  linkpeek worker (a `site: Nitter` scrape answers a real profile page,
  walls and parked pages don't; the probed user rotates so the worker's
  edge cache can't pin a dead pick). Candidates are a built-in list plus
  whatever [status.d420.de](https://status.d420.de/) still tracks, with
  [twiiit](https://twiiit.com/)'s per-click redirect as the last resort
  before `null`. Rechecked every 15 min
- `{type: 'auth', login, scopes}` or `{type: 'auth', error}` — result of
  an `auth` request (see above)
- `{type: 'wscause', code, reason}` — why the Twitch socket last closed,
  sent alongside each `reconnecting` status
- `{type: 'tweet', id, tweet}` — preview data (text, author, photo and
  video thumbnails, quoted-tweet media) for a status id the embedder
  requested with `{type: 'tweet', id}`, fetched from the FixTweet api
  (api.fxtwitter.com, then api.vxtwitter.com - same schema)
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
(pushes to main deploy it via the workflow; needs repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or run
`npx wrangler deploy` locally). It answers only the relay and embedder origins listed in
`ALLOWED`, vets every redirect hop, reads each page up to the end of
`<head>` (further, to 128 KB, when the head has no og:title or JSON-LD),
and has dedicated lookups for YouTube, GitHub, Wikipedia, Hacker News
items (via the official firebase api - HN itself refuses datacentre
fetches), Twitch channel links, Imgur posts (the real post title via
google's translate proxy, falling back to the image thumbnail card)
and Instagram reels (a playable mp4
resolved through kkclip on top of the reel page's own og: data). Twitch answers carry extra fact
chips from ivr.fi - live status, followers, chatters, account age,
role, and the channel's chat modes - and flag a short ttl while the
streamer is live so the cards refresh. The YouTube lookup also streams the
watch page far enough to pull the upload date and view count out of its
embedded player json, since oEmbed carries neither. For other pages it merges og/twitter tags, schema.org
JSON-LD, `<title>`/description, the page's advertised oEmbed endpoint,
its icon and theme-color, and any author and publish date. Hits cache
for a day.

## Presence beats

The relay page counts a browser only once its socket has delivered channel
data (a `ROOMSTATE`, `PRIVMSG`, `USERNOTICE` or `CLEARCHAT`). From then it
sends a beat to the Worker as `GET /?relay=<id>&...`: on that first data
(`ev=load`), about every 60-70 s (`tick`), on tab visibility changes (`vis`),
when the embedder messages a `me` tag (`me`), on a retry after a failed beat
(`retry`, at most 3 in a row, 5/15/45 s), and on `pagehide` (`bye`, never
retried). `?overlay` pages, and pages embedded from `localhost` or
`127.0.0.1`, send nothing. These are the only accepted values; the relay,
the Worker, nginx and `server/mkstats.py` each check them, so a change goes
in all four:

| param | value |
|---|---|
| `relay` | `[a-z0-9]{4,24}` per-tab id (sessionStorage) |
| `via` | `[a-z0-9][a-z0-9.-]{0,62}` embedding host |
| `me` | `[a-z0-9]{1,12}` the viewer's own label |
| `vid` | `[a-z0-9]{1,12}` per-browser id (localStorage) |
| `ch` | up to 6 comma-separated `[a-z0-9_]{2,25}` |
| `vis` | `v` or `h` |
| `au` / `bye` | `1` |
| `ev` | `load`, `tick`, `vis`, `me`, `retry`, `bye` |
| `n` / `err` | `\d{1,4}` beat count in this page load / failed beats so far |

The Worker writes valid beats to Analytics Engine and forwards them to
`orange.thingsandstuff.org/use`, where nginx appends one line to
`/var/log/nginx/use.txt` (`-` for a missing field), and only for beats that
carry an `ev` and a non-local `via`:

`timestamp id via bye me channels vis au ev n err vid`

A Durable Object caps beats at 8 a minute per id and 120 a minute per IP;
over-limit beats are dropped with a 200, and the limiter fails open.
`server/mkstats.py` (cron, every minute) is the one validator of the raw
log: it writes `stats.json` and the public 30-day `beats.txt` feed (the
first 8 fields only) the dashboard reads. The raw log stays private.
`server/usehealth.py` (cron, every 10 minutes) warns to syslog when
`stats.json` goes stale or no beat has landed for 3 hours. Both live in
`/opt/use-stats/` on the server; `python3 server/test_mkstats.py` runs their
tests. A session is one id's beats with no gap over 3 minutes, and a session
without a `bye` still counts as live for 3 minutes after its last beat (one
value, `session_s` in `stats.json`).

## Deploy

Push to `main`; GitHub Pages serves it.

## License

[AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html) - see [LICENSE](LICENSE).
