# Deepgram × Webfuse — live captions POC

<a href="https://webfuse.com"><img src="https://img.shields.io/badge/Webfuse-Extension-3b82f6"></a>
<a href="https://deepgram.com"><img src="https://img.shields.io/badge/Powered%20by-Deepgram-13EF93?colorB=0d1220"></a>

Real-time speech-to-text for Webfuse sessions:

1. **Demo site** (`site/index.html`, served from GitHub Pages) — live
   microphone captions (Deepgram Nova-3 streaming) and file transcription
   (pre-recorded REST).
2. **Token endpoint** (`server.js`) — zero-dependency, self-hostable:
   mints short-lived Deepgram grants, falls back to the raw key in labeled
   POC mode. Serves the site and `/api/token` locally.
3. **Webfuse extension** (`extension/`) — the same caption engine as a
   floating panel on **every page** of any Webfuse session in a Space,
   installed straight from this GitHub repository.

## Run locally (zero dependencies)

```bash
# DEEPGRAM_API_KEY lives in .env (already filled in for this POC)
node server.js
# → http://localhost:3337
```

Press **Start captions** and speak. Try: *"Show me how Webfuse and
Deepgram work together."*

## Deploy with GitHub

The repo is the deployment:

- **Demo site** — GitHub Pages publishes `site/` on every push to `main`
  (`.github/workflows/pages.yml`). On Pages the page runs in POC mode:
  click the badge to paste a Deepgram key (kept in the browser's
  localStorage).
- **Webfuse extension** — installed on a Space from this repository's
  `extension` branch (the `extension/` folder is mirrored there
  automatically on every push). Webfuse's importer requires the repo to be
  **public** and `manifest.json` at the ref's root — hence the branch.
- **Token endpoint** (optional, for grant mode) — host `server.js`
  anywhere with HTTPS and set `DEEPGRAM_API_KEY` in its environment.

## Configure the extension

In Webfuse Studio → Space → Extensions → Deepgram Live Captions → settings:

- `DEEPGRAM_API_KEY` — **POC mode**: paste a Deepgram key. No server
  needed; each participant's browser sends it straight to
  `api.deepgram.com`. (Participants can read extension settings from
  devtools — use a demo key and rotate it.)
- `TOKEN_URL` — **production mode**: an endpoint returning
  `{token, mode}` where `token` is a short-lived grant from
  `POST /v1/auth/grant` (needs a Member-permission key).

## How credentials work

- The preferred path: `GET /api/token` → `POST
  api.deepgram.com/v1/auth/grant` → 15-minute JWT → browser connects with
  `new WebSocket(url, ["token", credential])` (browsers can't set
  Authorization headers on WebSockets).
- **This POC's key cannot mint grants** (`/auth/grant` needs a
  Member-permission key), so every fallback is clearly labeled in the UI:
  raw-key fallback from the endpoint, pasted key on static hosting, or the
  extension's `DEEPGRAM_API_KEY` setting. Create a Member-permission key in
  the Deepgram console to switch to the secure path; no code changes.

## Repository layout

```
webfuse-deepgram/
├── site/index.html            landing page — the agent anatomy pitch (session startup page)
├── site/demo.html             hands-on demo: live mic captions + file transcription
├── server.js                  zero-dep local server: static + /api/token
├── extension/                 Webfuse extension (floating caption panel)
│   ├── manifest.json          env: DEEPGRAM_API_KEY, TOKEN_URL
│   ├── background.js          floats the detached popup
│   ├── popup.html/js          caption panel (mic → AudioWorklet → Deepgram WS)
│   └── README.md
├── .github/workflows/         pages.yml (publishes site/), extension-branch.yml (mirrors extension/ → extension branch)
├── .env                       DEEPGRAM_API_KEY (never commit)
└── GUIDE.md                   the complete guide
```

**Everything else — architecture, flows, the bugs we hit while building
this, troubleshooting, next steps — is in [GUIDE.md](GUIDE.md).**
