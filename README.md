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
returns it as `lines` for the embedder to dedup — and `{type: 'tweet',
id}` for a link preview.

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
  lastVod, emoteUse}` — name → CDN URL map merged from 7TV, BTTV, FFZ and
  animated FFZ (globals + channel sets), per-emote source labels, 7TV
  zero-width names, badge `set → version → image` maps from
  [ivr.fi](https://api.ivr.fi), per-emote channel usage counts from
  [StreamElements chatstats](https://api.streamelements.com/kappa/v2/chatstats/),
  plus stream history: `lastBroadcast` and the latest VOD's start/end
  from Twitch's public GraphQL endpoint
- `{type: 'nitter', host}` — fastest healthy nitter instance scraped
  from [status.d420.de](https://status.d420.de/), rechecked every 15 min
- `{type: 'auth', login, scopes}` or `{type: 'auth', error}` — result of
  an `auth` request (see above)
- `{type: 'wscause', code, reason}` — why the Twitch socket last closed,
  sent alongside each `reconnecting` status
- `{type: 'tweet', id, tweet}` — preview data (text, author, photo and
  video thumbnails, quoted-tweet media) for a status id the embedder
  requested with `{type: 'tweet', id}`, fetched from api.fxtwitter.com
- `{type: 'repo', stars, created, pushed}` — GitHub metadata for the
  embedder's repo, for its help panel

The relay holds the token only in memory — it isn't stored or forwarded
anywhere except the Twitch socket. (The embedder may persist it locally;
on this page it lives in localStorage until logout.)

## Deploy

Push to `main`; GitHub Pages serves it.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
