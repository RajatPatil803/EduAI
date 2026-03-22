/**
 * api.js — EduAI v2  Frontend API Layer
 * ─────────────────────────────────────────────────────────────
 * All outbound calls go through YOUR Express server (server.js).
 * The server holds the secret keys for Grok and ElevenLabs.
 *
 * Endpoints consumed:
 *   POST /api/generate   → Grok AI   → structured lesson JSON
 *   POST /api/tts        → ElevenLabs → MP3 audio buffer
 *   GET  /api/health     → server status check
 * ─────────────────────────────────────────────────────────────
 */

const API = (() => {

  const BASE = "http://localhost:4000";

  /* ── helpers ── */

  const _json = (raw) => {
    const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(clean);
  };

  const _validate = (obj) => {
    ["topic","conversation","simple_explanation","questions","summary"].forEach((f) => {
      if (!obj[f]) throw new Error(`AI response missing: "${f}"`);
    });
  };

  /* ── public ── */

  const generateLesson = async (text, onProgress) => {
    if (!text?.trim()) throw new Error("No text provided.");
    onProgress?.(10);

    let res;
    try {
      res = await fetch(`${BASE}/api/generate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: text.trim().slice(0, 8000) }),
      });
    } catch {
      throw new Error("Cannot reach the server. Run: node server.js");
    }

    onProgress?.(55);

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Server error ${res.status}: ${e.error || "unknown"}`);
    }

    const data = await res.json();
    onProgress?.(85);

    if (!data.result) throw new Error("Empty response from server.");

    let lesson;
    try { lesson = _json(data.result); }
    catch { throw new Error("Server returned invalid JSON — try again."); }

    _validate(lesson);
    onProgress?.(100);
    return lesson;
  };

  const generateAudio = async (lessonId, text) => {
    const res = await fetch(`${BASE}/api/tts`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ lessonId, text: text.slice(0, 3000) }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`TTS error ${res.status}: ${e.error || "unknown"}`);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  };

  /* 🔥 NEW: Dual voice */
  const generateDualAudio = async (conversation) => {
    const res = await fetch(`${BASE}/api/tts-dual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Dual TTS error ${res.status}: ${e.error || "unknown"}`);
    }

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  };

  const health = async () => {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch { return false; }
  };

  const readText = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = (e) => res(e.target.result || "");
    r.onerror = ()  => rej(new Error("Could not read file."));
    r.readAsText(file);
  });

  const readPDF = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const b = new Uint8Array(e.target.result);
        let t = "";
        for (let i = 0; i < b.length; i++) {
          const c = b[i];
          if (c >= 32 && c < 127) t += String.fromCharCode(c);
          else if (c === 10 || c === 13) t += " ";
        }
        res(t.replace(/\s+/g, " ").trim());
      } catch { rej(new Error("Could not parse PDF. Paste the text instead.")); }
    };
    r.onerror = () => rej(new Error("Could not read file."));
    r.readAsArrayBuffer(file);
  });

  return { generateLesson, generateAudio, generateDualAudio, health, readText, readPDF };
})();

window.API = API;