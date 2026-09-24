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
[hasanabi.neocities.org](https://github.com/mxmilkiib/hasanabi.neocities.org).

## Usage

```html
<iframe src="https://mxmilkiib.github.io/twitch-chat-relay/" hidden></iframe>
```

```js
iframe.contentWindow.postMessage({ type: 'join', channel: 'somechannel' },
                                 'https://mxmilkiib.github.io');
```

## Protocol

Parent → relay: `{type: 'join', channel}`

Relay → parent:

- `{type: 'status', state}` — connecting / connected / reconnecting
- `{type: 'lines', lines[]}` — raw Twitch IRC lines (tags + commands
  capabilities requested, PING/RECONNECT handled, exponential backoff)
- `{type: 'stream', uptime, viewers, title}` — from
  [DecAPI](https://decapi.me), polled every 60s
- `{type: 'emotes', emotes, emoteSrc, zeroWidth, badges, lastBroadcast,
  lastVod}` — name → CDN URL map merged from 7TV, BTTV, FFZ and animated
  FFZ (globals + channel sets), per-emote source labels, 7TV zero-width
  names, badge `set → version → image` maps from
  [ivr.fi](https://api.ivr.fi), plus stream history: `lastBroadcast` and
  the latest VOD's start/end from Twitch's public GraphQL endpoint
- `{type: 'nitter', host}` — fastest healthy nitter instance scraped
  from [status.d420.de](https://status.d420.de/), rechecked every 15 min

All fetches are anonymous — no tokens, no login.

## Deploy

Push to `main`; GitHub Pages serves it.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
