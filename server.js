// Local development server for the Deepgram × Webfuse captions POC.
//
//   node server.js     →  http://localhost:3337
//
// Serves the static demo (site/) and exposes GET /api/token with the same
// contract as the Netlify function in functions/token.mjs, so the whole demo
// runs locally without deploying. Zero npm dependencies. The Deepgram API key
// comes from DEEPGRAM_API_KEY or the .env file in this folder.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

// tiny .env loader (KEY=VALUE lines; comments and blanks are skipped)
if (existsSync(join(ROOT, ".env"))) {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT || 3337);
const KEY = process.env.DEEPGRAM_API_KEY;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
};

// Same mint-a-credential logic as functions/token.mjs. Duplicated on
// purpose: no build step, no shared imports — this file runs with zero
// dependencies.
async function mintCredential() {
  if (!KEY) {
    return {
      status: 500,
      body: { error: "DEEPGRAM_API_KEY is not set (put it in .env or the environment)" },
    };
  }
  try {
    const r = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: 900 }),
    });
    if (r.ok) {
      const { access_token } = await r.json();
      return { status: 200, body: { token: access_token, mode: "grant" } };
    }
    return {
      status: 200,
      body: {
        token: KEY,
        mode: "fallback-key",
        note: `auth/grant unavailable (HTTP ${r.status}) — returning the raw key for the POC. Create a Member-permission key in the Deepgram console to enable short-lived tokens.`,
      },
    };
  } catch (e) {
    return { status: 502, body: { error: `grant request failed: ${e.message}` } };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, type, body) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };

  if (req.method === "GET" && url.pathname === "/api/token") {
    const { status, body } = await mintCredential();
    return send(status, "application/json; charset=utf-8", JSON.stringify(body, null, 2));
  }

  // static files from site/
  let rel = normalize(decodeURIComponent(url.pathname)).split(sep).join("/");
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = join(ROOT, "site", rel);
  if (!file.startsWith(join(ROOT, "site") + sep)) {
    return send(403, "text/plain; charset=utf-8", "Forbidden");
  }
  try {
    const data = await readFile(file);
    await stat(file);
    return send(200, MIME[extname(file).toLowerCase()] || "application/octet-stream", data);
  } catch {
    return send(404, "text/plain; charset=utf-8", "Not found");
  }
});

server.listen(PORT, () => {
  console.log("Deepgram × Webfuse — live captions POC");
  console.log(`  http://localhost:${PORT}`);
  if (!KEY) console.log("  ! DEEPGRAM_API_KEY is not set — /api/token will error");
});
