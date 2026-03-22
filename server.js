/**
 * server.js — EduAI v2  Backend Server
 * ─────────────────────────────────────────────────────────────
 * Express server that:
 *   1. Serves the static frontend (index.html, css, js)
 *   2. POST /api/generate  — calls Grok AI (xAI)
 *   3. POST /api/tts       — calls ElevenLabs TTS
 *   4. GET  /api/lessons   — MongoDB: list all lessons
 *   5. POST /api/lessons   — MongoDB: save new lesson
 *   6. PUT  /api/lessons/:id — MongoDB: update lesson
 *   7. DELETE /api/lessons/:id — MongoDB: delete lesson
 *   8. GET  /api/health    — status check
 *
 * SETUP:
 *   npm install
 *   cp .env.example .env   → fill in all 3 keys
 *   node server.js
 *   Open → http://localhost:4000
 * ─────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const mongoose   = require("mongoose");
const OpenAI     = require("openai");
const { ElevenLabsClient } = require("elevenlabs");
const rateLimit  = require("express-rate-limit");
const axios = require("axios");

/* ══ Validate environment ══════════════════════════════════ */
const REQUIRED_ENV = ["MONGO_URI", "ELEVENLABS_API_KEY"];
REQUIRED_ENV.forEach((k) => {
  if (!process.env[k]) {
    console.error(`\n❌  Missing env var: ${k}`);
    console.error(`   Add it to your .env file.\n`);
    process.exit(1);
  }
});

/* ══ Grok client (OpenAI-compatible SDK) ═══════════════════ */
const grok = process.env.GROK_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROK_API_KEY,
      baseURL: "https://api.x.ai/v1",
    })
  : null;

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

/* ══ System prompt for Grok ════════════════════════════════ */
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
- Return ONLY the JSON object`;

/* ══ Express app ════════════════════════════════════════════ */
const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));  // serve frontend

/* ── Rate limiting ── */
const limiter = rateLimit({ windowMs: 60_000, max: 20, message: { error: "Too many requests — wait a minute." } });
app.use("/api/generate", limiter);
app.use("/api/tts",      limiter);

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /api/generate
   Body:    { text: string }
   Returns: { result: string }  (raw JSON string from Grok)
══════════════════════════════════════════════════════════ */
app.post("/api/generate", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text field is required." });

  const truncated = text.trim().slice(0, 8000);
  console.log(`[/api/generate] ${truncated.length} chars → Grok`);

  try {
  let result = "";

  // 🔹 Try Grok first (if key exists)
  if (grok) {
    try {
      const completion = await grok.chat.completions.create({
        model: process.env.GROK_MODEL || "grok-2",
        max_tokens: 4000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Convert this academic content into a learning experience:\n\n${truncated}` },
        ],
      });

      result = completion.choices?.[0]?.message?.content || "";
      console.log("✅ Grok success");

    } catch (grokErr) {
      console.log("⚠️ Grok failed, switching to OpenRouter...");
    }
  }

  // 🔹 Fallback to OpenRouter
  if (!result) {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-3.5-turbo",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: truncated }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    result = response.data.choices?.[0]?.message?.content || "";
    console.log("✅ OpenRouter success");
  }

  if (!result) return res.status(502).json({ error: "AI returned empty response." });

  return res.json({ result });

} catch (err) {
  console.error("[/api/generate] AI error:", err.message);
  return res.status(500).json({ error: err.message || "AI error." });
}
});

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /api/tts
   Body:    { lessonId: string, text: string }
   Returns: audio/mpeg binary stream
══════════════════════════════════════════════════════════ */
app.post("/api/tts-dual", async (req, res) => {
  const { conversation } = req.body;

  try {
    const chunks = [];

    for (const line of conversation) {
      const voiceId =
        line.speaker === "Student"
          ? process.env.ELEVENLABS_VOICE_ID_STUDENT
          : process.env.ELEVENLABS_VOICE_ID_PROFESSOR;

      const audioStream = await eleven.textToSpeech.convertAsStream(
        voiceId,
        {
          text: line.text.slice(0, 500),
          model_id: "eleven_multilingual_v2"
        }
      );

      for await (const chunk of audioStream) {
        chunks.push(chunk);
      }
    }

    const finalBuffer = Buffer.concat(chunks);

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(finalBuffer);

  } catch (err) {
    console.error("Dual TTS error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════
   ROUTES: /api/lessons  (MongoDB CRUD)
══════════════════════════════════════════════════════════ */

// GET — list all lessons newest-first
app.get("/api/lessons", async (_req, res) => {
  try {
    const lessons = await Lesson.find().sort({ createdAt: -1 }).lean();
    res.json(lessons);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — create new lesson
app.post("/api/lessons", async (req, res) => {
  try {
    const lesson = await Lesson.create(req.body);
    res.status(201).json(lesson);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT — update existing lesson
app.put("/api/lessons/:id", async (req, res) => {
  try {
    const lesson = await Lesson.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    res.json(lesson);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE — remove lesson
app.delete("/api/lessons/:id", async (req, res) => {
  try {
    await Lesson.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

/* ── Health check ── */
app.get("/api/health", (_req, res) => {
  res.json({
    status:  "ok",
    model:   process.env.GROK_MODEL || "grok-beta",
    db:      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
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