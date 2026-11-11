# Webfuse × Deepgram Live Captions — The Complete Guide

This guide explains everything in this project: what it does, how every
piece works, how to run and deploy it, the bugs we hit while building it,
and how to troubleshoot it.

---

## 1. What this is

A POC that puts **real-time AI captions anywhere a Webfuse session goes**:

1. **The demo page** (`site/index.html`, published to GitHub Pages) —
   two Deepgram speech-to-text demos that run in any browser:
   - *Live microphone captions* — streaming WebSocket transcription with
     interim results, powered by Nova-3.
   - *File transcription* — drag any audio/video file onto the page and get
     its full transcript (pre-recorded REST API).
2. **The Webfuse extension** (`extension/`) — the same caption engine as a
   floating panel injected into **every page of every session** of a
   Webfuse Space. The visitor opens a session link, clicks once, and talks;
   captions appear over whatever website the session is browsing. Because
   Webfuse sessions are shared, this is co-browsing with live captions —
   support agents and customers can both see the text of what is being
   said on any site.
3. **The token endpoint** (`server.js`) — a zero-dependency server you run
   locally (or self-host anywhere) that serves the demo page and mints
   Deepgram credentials: short-lived **JWT grants** when the key allows it
   (`POST /v1/auth/grant`), or the raw key in a clearly-labeled POC
   fallback.

Everything lives in one **public GitHub repository** — Webfuse installs
the extension straight from it, and GitHub Pages serves the demo page. No
third-party PaaS is involved.

---

## 2. The moving parts

```
   Visitor's browser (site/index.html — or the extension popup in a session)
   ├── mic → AudioWorklet → 16 kHz 16-bit PCM chunks (~100 ms)
   ├── credential (one of):
   │     ├── extension setting DEEPGRAM_API_KEY        (POC mode)
   │     ├── pasted key in the page badge              (POC mode, static hosting)
   │     └── GET /api/token  (server.js)  → POST api.deepgram.com/v1/auth/grant
   │                                     └── { access_token (JWT), expires_in }
   └── WS wss://api.deepgram.com/v1/listen   (subprotocol: ["token", credential])
         └── interim / final Results messages → transcript UI

   GitHub
   ├── repo  vipin-surfly/webfuse-deepgram (public — Webfuse imports from it)
   ├── Pages publishes site/ on every push to main (.github/workflows/pages.yml)
   └── extension/ subpath → installed on the Webfuse Space

   Webfuse
   ├── Space       "Deepgram POC" (meeting) — proxy config: apps + extensions
   ├── Extension   "Deepgram Live Captions" — floats the popup on every page
   │                settings: DEEPGRAM_API_KEY (POC) and/or TOKEN_URL
   └── Session     any website, co-browsed by N participants;
                   each participant's popup captures their own mic
```

| Piece | Lives | What it does |
|---|---|---|
| `site/index.html` | GitHub Pages (or `server.js` locally) | The whole demo page — one file, no frameworks, no CDN |
| `server.js` | your machine / any host | Zero-dependency server: static site + `/api/token` (grants, or raw-key fallback) |
| `extension/` | Webfuse Space | Floating caption panel on every page in every session of the Space |
| `vipin-surfly/webfuse-deepgram` | GitHub (public) | Source of truth; Webfuse imports the extension from it; Pages publishes the site |
| Deepgram | cloud | `/v1/listen` streaming STT (Nova-3), `/v1/listen` REST (files), `/v1/auth/grant` (tokens) |
| Webfuse | cloud | Spaces (proxy config), Sessions (shared co-browsing), Extensions |

---

## 3. Key concepts

### 3.1 Deepgram streaming auth — the subprotocol trick

Browsers **cannot set the `Authorization` header on a WebSocket**. Deepgram's
answer is the `Sec-WebSocket-Protocol` header, which the WebSocket
constructor *can* set:

```js
const ws = new WebSocket("wss://api.deepgram.com/v1/listen?…", ["token", credential]);
```

The credential is either the raw API key or a JWT from `POST
/v1/auth/grant`. A grant only needs to be valid at connect time — the
socket then lives as long as you keep it open.

### 3.2 Credential modes (in resolution order)

| Mode | Where the key lives | Badge | Production-ready |
|---|---|---|---|
| `grant` | server-side; endpoint mints 15-min JWTs | green *short-lived token* | yes |
| `fallback-key` | server-side key, endpoint returns it (key can't mint grants) | amber *POC: raw key fallback* | no |
| `pasted-key` | the visitor's localStorage (static hosting) | amber *POC: pasted key* | no |
| `key-setting` | the extension's `DEEPGRAM_API_KEY` setting | amber *POC key* | no |

`/v1/auth/grant` requires an API key with **Member** permission. This
POC's key returns `FORBIDDEN`, hence the fallbacks. **Fix:** create a
Member-permission key in the Deepgram console (API Keys → Create Key →
Advanced → Member), host `server.js` with it, set `TOKEN_URL` on the
extension — the badge flips to green with no code changes.

### 3.3 Streaming parameters that matter

| Param | Value | Why |
|---|---|---|
| `encoding` / `sample_rate` | `linear16` / actual ctx rate | raw PCM from the AudioWorklet; the context is created at 16 kHz but the code sends `ctx.sampleRate`, so any rate the browser forces still works |
| `interim_results` | `true` | gray streaming text before words are final |
| `smart_format` | `true` | punctuation + capitalization |
| `endpointing` | `300` | finalize after a 300 ms pause — snappy segments |
| `keyterm` | `Webfuse`, `Deepgram` | **Nova-3 only**; vocabulary boost so product names spell right |
| KeepAlive message | every 5 s | stops the server closing during silence (10 s no-data timeout, `net0001`) |

### 3.4 Webfuse

- **Space** — the configuration container (settings, apps, extensions).
- **Session** — a browsing instance of a Space; any website proxied through
  Webfuse, shareable in real time with multiple participants.
- **Extension** — a mini web extension installed on the Space (ours is
  imported from the GitHub repo); ours uses:
  - `manifest.json` `env` — extension settings (`DEEPGRAM_API_KEY`,
    `TOKEN_URL`), editable in Webfuse Studio, readable as
    `browser.webfuseSession.env.<KEY>`
  - `browser.browserAction.*` — a **detached popup** that floats over every
    page (bottom-right, always open) — the panel
  - `browser.webfuseSession.getSessionInfo()` — which session the panel is
    in (shown in the panel footer)
- **Extension runtime details that bit us** (from the Webfuse docs):
  - the popup runs on a dedicated **extensions origin**, so the browser's
    CSP applies: outbound `fetch`/WebSocket from the popup need
    `host_permissions` (ours: `<all_urls>`, which covers
    `api.deepgram.com`)
  - CORS applies to popup fetches — that's why a `TOKEN_URL` endpoint
    must send `Access-Control-Allow-Origin: *`

---

## 4. How the flows work

### 4.1 Live captions (site or extension panel)

1. Click **Start captions**.
2. The page/panel resolves a credential (see §3.2; badge updates).
3. `getUserMedia` prompts for the mic (constraints: echo cancellation +
   noise suppression + AGC — captions quality, and you don't want to
   transcribe your own speakers).
4. `AudioContext({sampleRate: 16000})` + an **AudioWorklet** (from a Blob
   URL — no separate asset to load) converts Float32 frames to Int16 PCM
   buffers and posts them out with an RMS level reading.
5. The WebSocket opens with the subprotocol credential; on open, the mic
   source connects to the worklet. A zero-gain sink node guarantees the
   browser keeps pulling the worklet even though nothing is played aloud.
6. Chunks stream; `Results` messages render — `is_final` segments lock in
   with a timestamp, interim text streams in gray with a blinking cursor.
7. A KeepAlive message goes out every 5 s during silence.
8. **Stop** sends `Finalize` (flushes pending audio into one last result),
   waits ~900 ms, then closes the socket and the audio graph.

### 4.2 File transcription

1. Pick (or drop) a file — an `<audio>` preview appears.
2. **Transcribe** resolves a credential and POSTs the file straight to
   `api.deepgram.com/v1/listen?model=nova-3&smart_format=true` (REST auth:
   `Bearer <JWT>` for grants, `Token <key>` for raw keys).
3. The transcript renders with duration and confidence.

### 4.3 The extension inside a session

1. The Space's `background.js` runs for every page load in every session:
   it styles, detaches and opens the popup — the floating caption panel.
2. The panel resolves its credential from the extension settings:
   `DEEPGRAM_API_KEY` first (POC mode), then `TOKEN_URL` (grant/fallback).
3. Mic capture runs in the participant's own browser; only the rendered
   text appears in the session.
4. The footer shows the session id (from `getSessionInfo()`), elapsed time
   and word count.

---

## 5. Repository layout

```
webfuse-deepgram/
├── site/index.html              the whole demo page (single file)
├── server.js                    zero-dep local server: static + /api/token
├── extension/                   Webfuse extension
│   ├── manifest.json            manifest v3 + env: DEEPGRAM_API_KEY, TOKEN_URL
│   ├── background.js            floats the detached popup over every page
│   ├── popup.html               panel UI
│   ├── popup.js                 mic → AudioWorklet → Deepgram WS → captions
│   └── README.md               extension-specific setup
├── .github/workflows/pages.yml  publishes site/ to GitHub Pages
├── package.json                 scripts: start (server.js)
├── .env                         DEEPGRAM_API_KEY (never commit)
├── README.md                    quick start
└── GUIDE.md                     this file
```

### Where credentials live

| Surface | Variable | Used by |
|---|---|---|
| `.env` / environment | `DEEPGRAM_API_KEY` | `server.js` (the token endpoint) |
| Webfuse Studio → extension settings | `DEEPGRAM_API_KEY` or `TOKEN_URL` | the extension popup |
| Browser localStorage (`dg_poc_key`) | pasted key | the demo page on static hosting |

---

## 6. Running and deploying

### Local (no install — zero dependencies)

```bash
node server.js          # .env is loaded automatically
# → http://localhost:3337
```

`server.js` serves `site/` and exposes `/api/token` (grants when the key
allows, raw-key fallback otherwise), so mic captions and file
transcription work fully locally. (`localhost` is a secure context, so
`getUserMedia` works.)

### The GitHub repository is the deployment

- **Demo page on GitHub Pages**: every push to `main` publishes `site/`
  (workflow `.github/workflows/pages.yml`). On Pages there is no
  `/api/token`, so the page offers POC mode — click the badge and paste a
  Deepgram key (kept in localStorage, sent only to `api.deepgram.com`).
- **Extension on a Webfuse Space**: in Webfuse Studio, install the
  extension **from the GitHub repo** (`vipin-surfly/webfuse-deepgram`,
  subpath `extension/`), or zip `extension/` and upload it. Webfuse's
  GitHub importer requires a **public** repo — keep it public, and keep
  every secret out of it (`.env` is gitignored; scan before pushing).
- **Token endpoint (optional, grant mode)**: host `server.js` on any
  HTTPS host with `DEEPGRAM_API_KEY` in its environment, then set
  `TOKEN_URL` on the extension (and point the page at it by serving it
  from the same origin).

### Configure the extension on the Space

1. Webfuse Studio → your Space → **Extensions** → Deepgram Live Captions.
2. In settings, set `DEEPGRAM_API_KEY` (POC mode — admin pastes a demo
   key) and/or `TOKEN_URL` (production mode).
3. Open a session on the Space — the panel floats over every page.

---

## 7. Bugs we hit and what they taught

Each of these cost real debugging time; all are fixed or designed around.

1. **`/v1/auth/grant` → `FORBIDDEN`.** The key needs Member permission to
   mint grants. Fix for the POC: labeled fallbacks (raw-key endpoint
   response, pasted key, extension setting) with UI badges everywhere.
   The permanent fix is a Member-permission key.
2. **`keywords` breaks the Nova-3 handshake.** Nova-3 rejects the classic
   `keywords=…` param — the WebSocket connection is refused outright
   (close 1006). Nova-3 uses **keyterm prompting**: `keyterm=Webfuse&
   keyterm=Deepgram` (repeated params, no weights). The page picks the
   right one per model.
3. **"Webfuse" transcribed as "WebView's".** Fixed by the keyterms above —
   a must for demos where the product name is said constantly.
4. **Browsers can't set WebSocket headers.** Deepgram auth from a browser
   has to ride the `Sec-WebSocket-Protocol`:
   `new WebSocket(url, ["token", credential])`.
5. **Server closes after 10 s of silence (`net0001`).** Deepgram drops the
   socket if it gets neither audio nor messages for ~10 s. Fix: a 5-second
   `{"type":"KeepAlive"}` heartbeat, and a clean `Finalize` → close on
   Stop.
6. **Worklets need a pull path.** An `AudioWorkletNode` with no downstream
   connection can be skipped by the browser's audio graph. Fix: connect
   it to a zero-gain `GainNode` → `destination`.
7. **Sample rates must be truthful.** The context is created with
   `sampleRate: 16000`, but if a browser ignores that, `ctx.sampleRate`
   reports the real rate — the code always sends the actual rate, never a
   hardcoded one.
8. **`/v1/keys` is gone.** The old "create short-lived API key" management
   endpoint 404s — `/v1/auth/grant` is the only grant path now.
9. **Extension popups live on a separate origin.** Popup scripts run on
   Webfuse's extensions origin: outbound connections need
   `host_permissions` (CSP `connect-src`), and fetches to `TOKEN_URL` need
   CORS `*` from that endpoint. A raw key in extension settings is
   readable by participants from devtools — POC only.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Badge shows "set key" | static hosting, no key pasted | click the badge, paste a demo key |
| "POC" amber badge of any kind | key can't mint grants / POC mode | expected today; Member key + hosted `server.js` for green |
| Mic button does nothing / error | permission denied | allow the mic for the page, try again |
| WS closes with code 1006 | bad credential or invalid params (e.g. `keywords` on Nova-3) | check the credential; keep `keyterm` for Nova-3 |
| WS closes `net0001` after silence | heartbeat missing/stopped | the app sends KeepAlive every 5 s while listening — don't pause the tab |
| Extension panel: "No credential configured" | neither `DEEPGRAM_API_KEY` nor `TOKEN_URL` set | Studio → Space → Extensions → settings |
| Extension panel: token endpoint HTTP error | `TOKEN_URL` wrong or down | open the URL directly; check CORS `*` |
| Extension imports fail from GitHub | repo private | the repo must be public for Webfuse's importer |
| Captions wrong product names | keyterms missing | `keyterm=Webfuse&keyterm=Deepgram` must be in the WS URL |
| Pages site stale | workflow didn't run | Actions tab → Deploy demo page to GitHub Pages → re-run |
| File card: "no speech found" | file has no speech / unsupported codec | try a wav/mp3/m4a with clear speech |

---

## 9. Where to go next

- **Speaker diarization** (`diarize=true`) — color-code two speakers in a
  support-session demo.
- **Captions for co-watched media** — capture a `<video>` element's stream
  (`captureStream()` + MediaRecorder or a MediaElementSource into the
  worklet) so sessions get live captions on any video they watch together.
- **Deepgram Voice Agent API** — one WebSocket for STT + LLM + TTS; the
  panel becomes a talking assistant that can also drive the session
  (combine with the Webfuse Session MCP, like the `webfuse-livekit` POC).
- **Production hardening** — Member-permission key + hosted `server.js`
  (grants instead of raw keys), restrict the token endpoint's CORS to
  your site + the Webfuse extensions origin, add per-IP rate limiting,
  and rotate any demo key that was shared.
- **Flux STT** — Deepgram's conversational model with built-in
  end-of-turn detection, if you move from captions to turn-taking.
