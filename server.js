/**
 * server.js — EduAI v2  Backend Server
 * ─────────────────────────────────────────────────────────────
 * Express server that:
 *   1. Serves the static frontend (index.html, css, js)
 *   2. POST /api/generate  — calls Google Gemini (FREE, no card)
 *   3. POST /api/tts       — calls ElevenLabs TTS
 *   4. GET  /api/lessons   — MongoDB: list all lessons
 *   5. POST /api/lessons   — MongoDB: save new lesson
 *   6. PUT  /api/lessons/:id — MongoDB: update lesson
 *   7. DELETE /api/lessons/:id — MongoDB: delete lesson
 *   8. GET  /api/health    — status check
 *
 * .env variables needed:
 *   GEMINI_API_KEY        → from aistudio.google.com (FREE, no card)
 *   MONGO_URI             → from cloud.mongodb.com
 *   ELEVENLABS_API_KEY    → from elevenlabs.io
 *   ELEVENLABS_VOICE_ID_PROFESSOR (optional)
 * ─────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const mongoose   = require("mongoose");
const { ElevenLabsClient } = require("elevenlabs");
const rateLimit  = require("express-rate-limit");

/* ══ Validate environment ══════════════════════════════════ */
const REQUIRED_ENV = ["GEMINI_API_KEY", "MONGO_URI", "ELEVENLABS_API_KEY"];
REQUIRED_ENV.forEach((k) => {
  if (!process.env[k]) {
    console.error(`\n❌  Missing env var: ${k}`);
    console.error(`   Add it to your .env file.\n`);
    process.exit(1);
  }
});

/* ══ Google Gemini client ═══════════════════════════════════ */
// Uses fetch directly — no extra SDK needed, works with the free REST API
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

/* ══ ElevenLabs client ══════════════════════════════════════ */
const eleven = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

/* ══ MongoDB connection ════════════════════════════════════ */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅  MongoDB connected"))
  .catch((err) => { console.error("❌  MongoDB error:", err.message); process.exit(1); });

/* ══ Mongoose schema ═══════════════════════════════════════ */
const lessonSchema = new mongoose.Schema({
  localId:            { type: String, index: true },
  topic:              { type: String, required: true },
  conversation:       [{ speaker: String, text: String }],
  simple_explanation: String,
  questions: {
    basic:    [{ q: String, a: String }],
    medium:   [{ q: String, a: String }],
    advanced: [{ q: String, a: String }],
  },
  summary:            [String],
  visual_suggestions: [{ timestamp: String, description: String, type: String }],
  audio_script: {
    student:   [String],
    professor: [String],
  },
  audioUrl:   { type: String, default: null },
  synced:     { type: Boolean, default: true },
  createdAt:  { type: Number, default: () => Date.now() },
}, { timestamps: true });

const Lesson = mongoose.model("Lesson", lessonSchema);

/* ══ System Prompt ═════════════════════════════════════════ */
const SYSTEM_PROMPT = `You are an intelligent educational AI. Given academic text, generate a structured JSON learning experience.

Return ONLY valid JSON — no markdown fences, no preamble, no extra text:
{
  "topic": "concise topic name (max 60 chars)",
  "conversation": [
    {"speaker": "Student",   "text": "..."},
    {"speaker": "Professor", "text": "..."}
  ],
  "simple_explanation": "plain-language explanation using analogies (2-4 sentences)",
  "questions": {
    "basic":    [{"q":"...","a":"..."},{"q":"...","a":"..."},{"q":"...","a":"..."}],
    "medium":   [{"q":"...","a":"..."},{"q":"...","a":"..."},{"q":"...","a":"..."}],
    "advanced": [{"q":"...","a":"..."},{"q":"...","a":"..."}]
  },
  "summary": ["bullet 1","bullet 2","bullet 3","bullet 4","bullet 5"],
  "visual_suggestions": [
    {"timestamp":"0:00","description":"...","type":"diagram|chart|illustration"}
  ],
  "audio_script": {
    "student":   ["line 1","line 2"],
    "professor": ["line 1","line 2"]
  }
}

Rules:
- conversation: 12-16 exchanges, ~2 minutes, engaging and fun
- simple_explanation: no jargon, use analogies
- questions: basic=recall, medium=comprehension, advanced=application
- summary: exactly 5 bullet strings
- visual_suggestions: 3-6 items with timestamps like "0:15"
- Return ONLY the JSON object, nothing else`;

/* ══ Express app ════════════════════════════════════════════ */
const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

/* ── Rate limiting ── */
const limiter = rateLimit({
  windowMs: 60_000, max: 20,
  message: { error: "Too many requests — wait a minute." }
});
app.use("/api/generate", limiter);
app.use("/api/tts",      limiter);

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /api/generate
   Body:    { text: string }
   Returns: { result: string }  (raw JSON string from Gemini)
   Auto-retries up to 3 times on 429 rate limit with backoff.
══════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const callGemini = async (prompt, retries = 3, delayMs = 10000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(GEMINI_API_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4000 }
      })
    });

    // Success path
    if (response.ok) {
      const data   = await response.json();
      const result = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return { ok: true, result };
    }

    const status  = response.status;
    const errData = await response.json().catch(() => ({}));

    // Rate limited — wait and retry automatically
    if (status === 429) {
      // Check if Gemini sends a retryDelay hint
      const retryAfterSec = errData?.error?.details
        ?.find(d => d["@type"]?.includes("RetryInfo"))
        ?.retryDelay?.replace("s","") || null;
      const waitMs = retryAfterSec ? parseInt(retryAfterSec) * 1000 : delayMs * attempt;
      console.log(`[Gemini] Rate limit hit. Waiting ${waitMs/1000}s before retry ${attempt}/${retries}…`);
      await sleep(waitMs);
      continue; // retry
    }

    // Hard failures — don't retry
    if (status === 400) return { ok: false, status: 400, error: "Bad request to Gemini." };
    if (status === 401 || status === 403) return { ok: false, status: 401, error: "Invalid Gemini API key — check GEMINI_API_KEY in your .env file." };
    return { ok: false, status: 500, error: `Gemini API error ${status}` };
  }

  // All retries exhausted
  return { ok: false, status: 503, error: "Gemini is busy right now. Please wait 1 minute and try again." };
};

app.post("/api/generate", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text field is required." });

  const truncated = text.trim().slice(0, 8000);
  console.log(`[/api/generate] ${truncated.length} chars → Gemini`);

  try {
    const prompt = `Convert this academic content into a learning experience:\n\n${truncated}`;
    const { ok, result, status, error } = await callGemini(prompt);

    if (!ok) {
      console.error(`[/api/generate] Failed: ${error}`);
      return res.status(status || 500).json({ error });
    }

    if (!result) return res.status(502).json({ error: "Gemini returned empty response." });

    console.log(`[/api/generate] ✅ ${result.length} chars returned`);
    return res.json({ result });

  } catch (err) {
    console.error("[/api/generate] Network error:", err.message);
    return res.status(500).json({ error: "Failed to reach Gemini API. Check your internet connection." });
  }
});

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /api/tts
   Body:    { lessonId: string, text: string }
   Returns: audio/mpeg binary stream
══════════════════════════════════════════════════════════ */
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text field is required." });

  const voiceId = process.env.ELEVENLABS_VOICE_ID_PROFESSOR
                || process.env.ELEVENLABS_VOICE_ID
                || "JBFqnCBsd6RMkjVDRZzb"; // default: George

  console.log(`[/api/tts] Generating audio (${text.length} chars)`);

  try {
    const audioStream = await eleven.textToSpeech.convertAsStream(voiceId, {
      text:            text.slice(0, 3000),
      model_id:        "eleven_multilingual_v2",
      voice_settings:  { stability: 0.5, similarity_boost: 0.75 },
      output_format:   "mp3_44100_128",
    });

    res.setHeader("Content-Type",  "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");

    for await (const chunk of audioStream) { res.write(chunk); }
    res.end();
    console.log(`[/api/tts] ✅ Audio streamed`);

  } catch (err) {
    console.error("[/api/tts] ElevenLabs error:", err.message);
    return res.status(500).json({ error: err.message || "ElevenLabs TTS error." });
  }
});

/* ══════════════════════════════════════════════════════════
   ROUTES: /api/lessons  (MongoDB CRUD)
══════════════════════════════════════════════════════════ */

app.get("/api/lessons", async (_req, res) => {
  try {
    const lessons = await Lesson.find().sort({ createdAt: -1 }).lean();
    res.json(lessons);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/lessons", async (req, res) => {
  try {
    const lesson = await Lesson.create(req.body);
    res.status(201).json(lesson);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put("/api/lessons/:id", async (req, res) => {
  try {
    const lesson = await Lesson.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    res.json(lesson);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/api/lessons/:id", async (req, res) => {
  try {
    await Lesson.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ── Health check ── */
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    ai:     "Google Gemini 2.0 Flash (free)",
    db:     mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

/* ── Fallback ── */
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api/")) res.sendFile(path.join(__dirname, "index.html"));
});

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`\n🚀  EduAI v2 running!`);
  console.log(`   App:    http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
