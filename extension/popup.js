// Deepgram voice agent + live captions for Webfuse sessions.
//
// The visitor opens a Webfuse session (the Space link). This extension puts
// a floating panel on every page of that session. Two modes:
//
//   agent    — the full loop from the landing page: Nova-3 listens,
//              gpt-4o-mini (managed by Deepgram — no extra provider key)
//              thinks, Aura-2 speaks. Conversational transcript, audio
//              playback and barge-in (the agent stops talking when you do).
//   captions — live captions only (Nova-3 streaming STT, /v1/listen).
//
//   - mic → AudioWorklet → 16 kHz 16-bit PCM → Deepgram WebSocket
//     (wss://agent.deepgram.com/v1/agent/converse for the agent,
//      wss://api.deepgram.com/v1/listen for captions)
//   - the credential comes from the extension settings (POC) or TOKEN_URL
//     (production); see the credential section below
//
// Audio is captured in the visitor's own browser and sent straight to
// Deepgram; only text renders in the panel, so nothing sensitive passes
// through the co-browsed website.

const mic = document.getElementById("mic");
const micLabel = document.getElementById("micLabel");
const capBtn = document.getElementById("capOnly");
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

/* ------------------- audio engine (mic → PCM) ------------------------- */

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

/* ------------------------------ transcript ---------------------------- */

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

// agent mode: chat bubbles — "you" (right) and "agent" (left)
function addLine(speaker, text) {
  const p = document.createElement("div");
  p.className = `line ${speaker}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = speaker === "you" ? "you" : "agent";
  p.append(who, document.createElement("br"), document.createTextNode(text));
  transcript.appendChild(p);
  transcript.scrollTop = transcript.scrollHeight;
  live.words += text.trim().split(/\s+/).filter(Boolean).length;
  updateStats();
}

function updateStats() {
  const s = running ? Math.floor((Date.now() - live.startedAt) / 1000) : 0;
  const mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, "0");
  const sid = sessionId ? ` · session ${String(sessionId).slice(0, 10)}…` : "";
  statsEl.textContent = `${mm}:${ss} · ${live.words} words${sid}`;
}

/* -------------------- agent audio playback (24 kHz) ------------------- */

// The mic context runs at 16 kHz but the agent speaks linear16 @ 24 kHz;
// one AudioContext has one sample rate, so playback gets its own.
function makePlayback() {
  const pctx = new AudioContext({ sampleRate: 24000 });
  const st = { nextTime: 0, sources: [] };

  st.queue = (buf) => {
    // buf: ArrayBuffer of Int16 mono PCM @ 24 kHz
    const i16 = new Int16Array(buf);
    const f32 = new Float32Array(i16.length);
    for (let k = 0; k < i16.length; k++) f32[k] = i16[k] / 32768;
    const audioBuf = pctx.createBuffer(1, f32.length, 24000);
    audioBuf.copyToChannel(f32, 0);
    const src = pctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(pctx.destination);
    if (pctx.state === "suspended") pctx.resume();
    const t = Math.max(pctx.currentTime + 0.03, st.nextTime);
    src.start(t);
    st.nextTime = t + audioBuf.duration;
    st.sources.push(src);
    src.onended = () => { st.sources = st.sources.filter((s) => s !== src); };
    setStatus("Speaking", "live");
  };

  // barge-in: drop everything queued/scheduled right now
  st.interrupt = () => {
    for (const s of st.sources) { try { s.stop(); } catch {} }
    st.sources = [];
    st.nextTime = 0;
  };

  st.close = () => {
    st.interrupt();
    pctx.close().catch(() => {});
  };

  return st;
}

let play = null; // agent mode only

/* ------------------------------- start -------------------------------- */

async function start(agentMode) {
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
    micLabel.textContent = "Talk";
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
    micLabel.textContent = "Talk";
    return;
  }

  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" })));

    const node = new AudioWorkletNode(ctx, "pcm-capture");
    // zero-gain sink guarantees the worklet is pulled by the audio graph
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);

    let ws;
    if (agentMode) {
      ws = wireAgent(token, ctx, stream, node);
    } else {
      ws = wireCaptions(token, ctx, stream, node);
    }

    node.port.onmessage = (e) => {
      level.style.width = `${Math.min(100, Math.round(e.data.rms * 320))}%`;
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data.pcm);
    };

    Object.assign(live, { ws, ctx, stream, node, startedAt: Date.now() });
    running = true;
    screen.style.display = "none";
    liveView.style.display = "flex";
    liveView.classList.add("fade");
    if (!agentMode) setStatus("Listening", "live"); // agent mode waits for SettingsApplied
    updateStats();
    live.statsTimer = setInterval(updateStats, 1000);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    showError(`Could not start: ${e.message}`);
    setStatus("Failed", "err");
  }
  mic.disabled = false;
  micLabel.textContent = "Talk";
}

/* ------------------- captions mode (/v1/listen) ------------------------ */

function wireCaptions(token, ctx, stream, node) {
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
  return ws;
}

/* --------------------- agent mode (/v1/agent/converse) ---------------- */

// One WebSocket, full pipeline: listen (Nova-3) → think (gpt-4o-mini,
// managed by Deepgram — no OpenAI key needed) → speak (Aura-2).
// Flow: Welcome → Settings → SettingsApplied → stream mic PCM;
// ConversationText events carry both sides of the conversation;
// binary frames are the agent's speech (linear16 @ 24 kHz).
function wireAgent(token, ctx, stream, node) {
  const ws = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", ["token", token]);
  ws.binaryType = "arraybuffer";
  play = makePlayback();

  const settings = {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: ctx.sampleRate },
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    },
    agent: {
      greeting: "Hello! I am the Webfuse and Deepgram demo agent. How can I help you today?",
      listen: {
        provider: {
          type: "deepgram",
          model: "nova-3",
          smart_format: true,
          keyterms: ["Webfuse", "Deepgram"],
        },
      },
      think: {
        provider: { type: "open_ai", model: "gpt-4o-mini", temperature: 0.7 },
        prompt: "You are a friendly voice agent demoing Webfuse and Deepgram for a proof of concept. Keep answers short (1-3 sentences), speak naturally, and mention Webfuse co-browsing or Deepgram speech AI when relevant.",
      },
      speak: {
        provider: { type: "deepgram", version: "v1", model: "aura-2-thalia-en" },
      },
    },
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      play.queue(ev.data); // agent speech: Int16 PCM @ 24 kHz
      return;
    }
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "Welcome":
        ws.send(JSON.stringify(settings));
        break;
      case "SettingsApplied":
        ctx.createMediaStreamSource(stream).connect(node);
        setStatus("Listening", "live");
        live.keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
        }, 5000);
        break;
      case "UserStartedSpeaking":
        play.interrupt(); // barge-in: stop talking when the user does
        setStatus("Listening", "live");
        break;
      case "ConversationText":
        addLine(m.role === "user" ? "you" : "agent", m.content);
        break;
      case "AgentThinking":
        setStatus("Thinking…", "live");
        break;
      case "AgentAudioDone":
        setStatus("Listening", "live");
        break;
      case "Error":
        showError(m.description || "The agent connection failed.");
        stop();
        break;
      // Welcome/LatencyReport/History/… — nothing to render
    }
  };

  ws.onerror = () => showError("WebSocket error — see the browser console. (Credential rejected?)");
  ws.onclose = (e) => {
    if (running) {
      stop();
      if (e.code !== 1000) showError(`Connection closed (${e.code}${e.reason ? ": " + e.reason : ""}).`);
    }
  };
  return ws;
}

/* -------------------------------- stop -------------------------------- */

function stop() {
  running = false;
  if (live.keepAlive) clearInterval(live.keepAlive);
  if (live.statsTimer) clearInterval(live.statsTimer);
  try { if (live.node) live.node.disconnect(); } catch {}
  try { if (live.stream) live.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (live.ctx) live.ctx.close(); } catch {}
  if (play) { play.close(); play = null; }
  if (live.ws) {
    if (live.ws.readyState === WebSocket.OPEN) {
      try { live.ws.send(JSON.stringify({ type: "Finalize" })); } catch {}
      const ws = live.ws;
      setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); }, 900);
    }
    live.ws = null;
  }
  Object.assign(live, { ctx: null, stream: null, node: null });
  level.style.width = "0%";
  setInterim("");
  liveView.style.display = "none";
  screen.style.display = "flex";
  setStatus("Stopped");
  updateStats();
}

/* ------------------------------- wiring ------------------------------- */

mic.addEventListener("click", () => { if (!running) start(true); });
capBtn.addEventListener("click", () => { if (!running) start(false); });
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
