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
══════════════════════════════════════════════════════════ */
app.post("/api/generate", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text field is required." });

  const truncated = text.trim().slice(0, 8000);
  console.log(`[/api/generate] ${truncated.length} chars → Gemini`);

  try {
    const response = await fetch(GEMINI_API_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [{
          parts: [{ text: `Convert this academic content into a learning experience:\n\n${truncated}` }]
        }],
        generationConfig: {
          temperature:     0.7,
          maxOutputTokens: 4000,
        }
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const status  = response.status;
      console.error("[/api/generate] Gemini error:", status, errData);
      if (status === 400) return res.status(400).json({ error: "Bad request to Gemini API." });
      if (status === 401 || status === 403) return res.status(401).json({ error: "Invalid Gemini API key. Check your .env file — GEMINI_API_KEY." });
      if (status === 429) return res.status(429).json({ error: "Gemini free tier rate limit hit. Wait 60 seconds and try again." });
      return res.status(500).json({ error: `Gemini API error ${status}` });
    }

    const data   = await response.json();
    const result = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!result) return res.status(502).json({ error: "Gemini returned empty response." });

    console.log(`[/api/generate] ✅ ${result.length} chars returned`);
    return res.json({ result });

  } catch (err) {
    console.error("[/api/generate] Network error:", err.message);
    return res.status(500).json({ error: err.message || "Failed to reach Gemini API." });
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
