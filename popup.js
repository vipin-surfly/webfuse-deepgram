// Deepgram live captions for Webfuse sessions.
//
// The visitor opens a Webfuse session (the Space link). This extension puts
// a floating caption panel on every page of that session. One click starts
// real-time speech-to-text of the visitor's microphone:
//
//   - mic → AudioWorklet → 16 kHz 16-bit PCM → Deepgram /v1/listen WebSocket
//   - interim results stream in gray; finalized segments lock in
//   - the credential comes from TOKEN_URL (extension setting), a small HTTPS
//     endpoint the FDE deploys — no Deepgram secret ships in the extension
//
// Audio is captured in the visitor's own browser and sent straight to
// Deepgram; only text renders in the panel, so nothing sensitive passes
// through the co-browsed website.

const mic = document.getElementById("mic");
const micLabel = document.getElementById("micLabel");
const hint = document.getElementById("hint");
const errBox = document.getElementById("err");
const screen = document.getElementById("screen");
const liveView = document.getElementById("live");
const transcript = document.getElementById("transcript");
const level = document.getElementById("level");
const dot = document.getElementById("dot");
const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const statsEl = document.getElementById("stats");
const stopBtn = document.getElementById("stop");

let running = false;
let sessionId = null;
let tokenMode = null;

function setStatus(text, cls) {
  statusEl.textContent = text;
  dot.className = "dot" + (cls ? " " + cls : "");
}

function showError(msg) {
  errBox.style.display = "block";
  errBox.textContent = msg;
}

/* ------------------------- credential (extension env) ---------------- */

// Extension settings (Webfuse Studio → Space → Extensions → settings):
//   DEEPGRAM_API_KEY — POC mode: the raw key, configured by the admin.
//                     No hosted endpoint needed; sent straight to Deepgram.
//   TOKEN_URL        — production mode: an endpoint returning {token, mode},
//                     where token is a short-lived grant (POST /v1/auth/grant)
//                     or, as fallback, the raw key. See server.js in the repo.
// DEEPGRAM_API_KEY is checked first; configure one of the two.

function extEnv() {
  return (typeof browser !== "undefined" && browser.webfuseSession && browser.webfuseSession.env) || {};
}

async function getToken() {
  const env = extEnv();
  const key = (env.DEEPGRAM_API_KEY || "").trim();
  if (key) return { token: key, mode: "key-setting" };

  const url = (env.TOKEN_URL || "").trim();
  if (url) {
    const res = await fetch(url);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.token) throw new Error(j.error || `token endpoint: HTTP ${res.status}`);
    return j; // { token, mode }
  }

  throw new Error("No credential configured. Set DEEPGRAM_API_KEY (POC mode) or TOKEN_URL in this extension's settings (Webfuse Studio → Space → Extensions).");
}

function showMode(mode) {
  tokenMode = mode;
  modeEl.hidden = false;
  if (mode === "grant") {
    modeEl.textContent = "temp token";
    modeEl.className = "mode grant";
    modeEl.title = "The token endpoint mints short-lived Deepgram grants. The API key stays server-side.";
  } else {
    modeEl.textContent = "POC key";
    modeEl.className = "mode fallback-key";
    modeEl.title = mode === "key-setting"
      ? "Using the DEEPGRAM_API_KEY extension setting (POC mode). Participants can read extension settings from devtools — use a demo key and rotate it."
      : "The token endpoint returned the raw API key (it cannot mint short-lived grants). Create a Member-permission Deepgram key to enable the secure path.";
  }
}

/* ------------------- live caption engine (mic → PCM) ----------------- */

// AudioWorklet processor: Float32 mic frames → Int16 PCM buffers.
// Created from a Blob URL so the popup is self-contained.
const WORKLET_SRC = `
class PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      let sum = 0;
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / ch.length) }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-capture", PCMCapture);
`;

const live = { ws: null, ctx: null, stream: null, node: null, keepAlive: null, statsTimer: null, startedAt: 0, words: 0 };

function addFinal(text) {
  const p = document.createElement("div");
  p.className = "final";
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  p.append(t, document.createTextNode(text));
  transcript.appendChild(p);
  transcript.scrollTop = transcript.scrollHeight;
  live.words += text.trim().split(/\s+/).filter(Boolean).length;
  updateStats();
}

const interimEl = document.createElement("div");
interimEl.className = "interim";

function setInterim(text) {
  if (!text) { interimEl.remove(); return; }
  interimEl.textContent = text;
  transcript.appendChild(interimEl);
  transcript.scrollTop = transcript.scrollHeight;
}

function updateStats() {
  const s = running ? Math.floor((Date.now() - live.startedAt) / 1000) : 0;
  const mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, "0");
  const sid = sessionId ? ` · session ${String(sessionId).slice(0, 10)}…` : "";
  statsEl.textContent = `${mm}:${ss} · ${live.words} words${sid}`;
}

async function start() {
  mic.disabled = true;
  micLabel.textContent = "…";
  errBox.style.display = "none";
  setStatus("Connecting…");

  let token;
  try {
    const j = await getToken();
    showMode(j.mode);
    token = j.token;
  } catch (e) {
    showError(`Could not get a credential: ${e.message}`);
    setStatus("Failed", "err");
    mic.disabled = false;
    micLabel.textContent = "Start";
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    showError(e.name === "NotAllowedError"
      ? "Microphone permission was denied. Allow mic access for this page and try again."
      : `Could not open the microphone: ${e.message}`);
    setStatus("Failed", "err");
    mic.disabled = false;
    micLabel.textContent = "Start";
    return;
  }

  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" })));

    const params = new URLSearchParams({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: String(ctx.sampleRate),
      smart_format: "true",
      interim_results: "true",
      endpointing: "300",
    });
    // keyterm prompting (nova-3) so product names come out spelled right
    params.append("keyterm", "Webfuse");
    params.append("keyterm", "Deepgram");

    // Browsers cannot set the Authorization header on a WebSocket, so the
    // credential rides the Sec-WebSocket-Protocol: token, <credential>.
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", token]);

    const node = new AudioWorkletNode(ctx, "pcm-capture");
    node.port.onmessage = (e) => {
      level.style.width = `${Math.min(100, Math.round(e.data.rms * 320))}%`;
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data.pcm);
    };
    // zero-gain sink guarantees the worklet is pulled by the audio graph
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);

    ws.onopen = () => {
      ctx.createMediaStreamSource(stream).connect(node);
      live.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 5000);
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== "Results" || !m.channel) return;
      const alt = m.channel.alternatives && m.channel.alternatives[0];
      if (!alt) return;
      if (m.is_final) { setInterim(""); addFinal(alt.transcript); }
      else setInterim(alt.transcript);
    };

    ws.onerror = () => showError("WebSocket error — see the browser console. (Credential rejected?)");
    ws.onclose = (e) => {
      if (running) {
        stop();
        if (e.code !== 1000) showError(`Connection closed (${e.code}${e.reason ? ": " + e.reason : ""}).`);
      }
    };

    Object.assign(live, { ws, ctx, stream, node, startedAt: Date.now() });
    running = true;
    screen.style.display = "none";
    liveView.style.display = "flex";
    liveView.classList.add("fade");
    setStatus("Listening", "live");
    updateStats();
    live.statsTimer = setInterval(updateStats, 1000);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    showError(`Could not start: ${e.message}`);
    setStatus("Failed", "err");
  }
  mic.disabled = false;
  micLabel.textContent = "Start";
}

function stop() {
  running = false;
  if (live.keepAlive) clearInterval(live.keepAlive);
  if (live.statsTimer) clearInterval(live.statsTimer);
  try { if (live.node) live.node.disconnect(); } catch {}
  try { if (live.stream) live.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (live.ctx) live.ctx.close(); } catch {}
  if (live.ws && live.ws.readyState === WebSocket.OPEN) {
    live.ws.send(JSON.stringify({ type: "Finalize" }));
    const ws = live.ws;
    setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); }, 900);
  }
  Object.assign(live, { ws: null, ctx: null, stream: null, node: null });
  level.style.width = "0%";
  setInterim("");
  liveView.style.display = "none";
  screen.style.display = "flex";
  setStatus("Stopped");
  updateStats();
}

/* ------------------------------- wiring ------------------------------- */

mic.addEventListener("click", () => { if (!running) start(); });
stopBtn.addEventListener("click", stop);

// Which Webfuse session are we floating in? (Display only.)
(async () => {
  try {
    if (typeof browser !== "undefined" && browser.webfuseSession?.getSessionInfo) {
      const info = await browser.webfuseSession.getSessionInfo();
      sessionId = info.sessionId || info.session_id || null;
      updateStats();
    }
  } catch (e) { /* session info is cosmetic — ignore failures */ }
})();
