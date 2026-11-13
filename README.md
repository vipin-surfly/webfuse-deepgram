# Deepgram Voice Agent & Live Captions

<a href="https://webfuse.com"><img src="https://img.shields.io/badge/Webfuse-Extension-3b82f6"></a>
<a href="https://deepgram.com"><img src="https://img.shields.io/badge/Powered%20by-Deepgram-13EF93?colorB=0d1220"></a>

Put a talking AI agent inside every page of a Webfuse session: the visitor
opens the session link, a floating panel appears in the corner, and one
click starts a full voice loop — the agent **listens** (Deepgram Nova-3),
**thinks** (gpt-4o-mini, managed by Deepgram — no extra provider key) and
**answers out loud** (Deepgram Aura-2 voice), with barge-in when the visitor
speaks over it. A second button runs **live captions only** (streaming
STT, no agent). Audio goes straight from each participant's browser to
Deepgram — only text renders in the session.

> **[Deepgram Voice Agent API](https://developers.deepgram.com/docs/voice-agent)**
> (`wss://agent.deepgram.com/v1/agent/converse`)
> + **[Webfuse Spaces & Sessions](https://dev.webfuse.com/spaces-sessions)**
> + **[Webfuse Extensions](https://dev.webfuse.com/extensions)**

## 1. Configure a credential

The panel needs a Deepgram credential. Two ways, configured in the
extension's settings (Webfuse Studio → Space → Extensions → this
extension → settings):

- **`DEEPGRAM_API_KEY`** *(POC mode)* — paste a Deepgram API key. No
  server needed; the key is sent from each participant's browser directly
  to `api.deepgram.com`. Participants *can* read extension settings from
  their devtools, so use a demo key and rotate it.
- **`TOKEN_URL`** *(production mode)* — an HTTPS endpoint that returns:

  ```json
  { "token": "<credential>", "mode": "grant" }
  ```

  `mode: "grant"` is a short-lived JWT minted with `POST /v1/auth/grant`
  (needs a Member-permission key; only has to be valid when the WebSocket
  connects). `mode: "fallback-key"` returns the raw key. The endpoint must
  send `Access-Control-Allow-Origin: *` — the popup fetches it
  cross-origin from the Webfuse extensions origin. `server.js` in this
  repository is a ready-to-host implementation.

`DEEPGRAM_API_KEY` is checked first; set one or the other.

## 2. Install on a Webfuse Space

The extension lives at `extension/` in
[github.com/vipin-surfly/webfuse-deepgram](https://github.com/vipin-surfly/webfuse-deepgram);
a workflow mirrors that folder to the repo's `extension` branch, which is
what Webfuse installs from (the importer needs `manifest.json` at the ref's
root).

1. Create a Space (Meeting or Shared if several people should join the
   same session).
2. In Webfuse Studio, install the extension **from the GitHub repository**
   (repo `vipin-surfly/webfuse-deepgram`, ref `extension`), or zip this
   folder and upload it.
3. Configure the credential as above.
4. Open a session on the Space and browse anywhere — the caption panel
   floats over every page.

## How it behaves in a session

- The panel is a detached Webfuse popup: it floats over every page in the
  session and stays open while the session runs.
- Two modes: **Talk** starts the voice agent (greeting first, then a spoken
  conversation with chat-style transcript); **captions only** runs the
  original live-caption demo.
- The agent stops speaking the moment the visitor starts talking
  (barge-in, via `UserStartedSpeaking`).
- Mic capture happens in each participant's own browser, so every
  participant runs their own conversation/captions.
- The panel shows which Webfuse session it is floating in (from
  `browser.webfuseSession.getSessionInfo()`), plus elapsed time and word
  count.
- Vocabulary boost: keyterms `Webfuse`, `Deepgram` (Nova-3 keyterm
  prompting) so product names transcribe spelled right.
- Agent loop verified end-to-end against the real API: greeting spoken,
  user speech transcribed, LLM reply generated and returned as 24 kHz
  linear16 audio (see `GUIDE.md` for the protocol notes, including why
  the endpoint is `/v1/agent/converse` and a second `AudioContext` is
  needed for playback).
