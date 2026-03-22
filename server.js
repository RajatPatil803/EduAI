/**
 * server.js — EduAI v2  Backend Server
 * ─────────────────────────────────────────────────────────────
 * Uses Google Gemini FREE tier with smart model fallback:
 *   Primary:   gemini-2.5-flash-lite  (15 RPM, 1000 RPD)
 *   Fallback:  gemini-1.5-flash       (15 RPM, 1500 RPD)
 *
 * .env variables needed:
 *   GEMINI_API_KEY        → from aistudio.google.com (FREE)
 *   MONGO_URI             → from cloud.mongodb.com
 *   ELEVENLABS_API_KEY    → from elevenlabs.io
 * ─────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const mongoose   = require("mongoose");
const { ElevenLabsClient } = require("elevenlabs");
const rateLimit  = require("express-rate-limit");

/* ══ Validate env ══════════════════════════════════════════ */
["GEMINI_API_KEY", "MONGO_URI", "ELEVENLABS_API_KEY"].forEach((k) => {
  if (!process.env[k]) {
    console.error(`\n❌  Missing env var: ${k}\n   Add it to your .env file.\n`);
    process.exit(1);
  }
});

/* ══ Gemini model cascade (best free limits → fallback) ════ */
const MODELS = [
  "gemini-2.5-flash-lite-preview-06-17",  // 15 RPM, 1000 RPD — best free option
  "gemini-1.5-flash",                      // 15 RPM, 1500 RPD — highest daily limit
  "gemini-2.5-flash",                      // 10 RPM, 250 RPD  — fallback
];

const geminiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

/* ══ ElevenLabs ════════════════════════════════════════════ */
const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

/* ══ MongoDB ═══════════════════════════════════════════════ */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅  MongoDB connected"))
  .catch((err) => { console.error("❌  MongoDB:", err.message); process.exit(1); });

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
  audio_script: { student: [String], professor: [String] },
  audioUrl:   { type: String, default: null },
  synced:     { type: Boolean, default: true },
  createdAt:  { type: Number, default: () => Date.now() },
}, { timestamps: true });

const Lesson = mongoose.model("Lesson", lessonSchema);

/* ══ System prompt ═════════════════════════════════════════ */
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
- simple_explanation: no jargon, use everyday analogies
- questions: basic=recall, medium=comprehension, advanced=application
- summary: exactly 5 bullet strings
- visual_suggestions: 3-6 items with realistic timestamps like "0:15"
- Return ONLY the JSON object, nothing else`;

/* ══ Express app ════════════════════════════════════════════ */
const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

const limiter = rateLimit({
  windowMs: 60_000, max: 15,
  message: { error: "Too many requests — wait a minute." }
});
app.use("/api/generate", limiter);
app.use("/api/tts",      limiter);

/* ══ Gemini helper — cascades through models on 429 ════════ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const callGemini = async (userPrompt) => {
  for (let m = 0; m < MODELS.length; m++) {
    const model = MODELS[m];
    let lastError = null;

    // Try each model up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`[Gemini] model=${model} attempt=${attempt}`);

      const res = await fetch(geminiUrl(model), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 4000 }
        })
      });

      // Success
      if (res.ok) {
        const data   = await res.json();
        const result = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (result) {
          console.log(`[Gemini] ✅ model=${model} chars=${result.length}`);
          return { ok: true, result, model };
        }
      }

      const status  = res.status;
      const errBody = await res.json().catch(() => ({}));

      // Auth error — stop completely, no point retrying
      if (status === 401 || status === 403) {
        return { ok: false, status: 401, error: "Invalid Gemini API key. Check GEMINI_API_KEY in your .env file." };
      }

      // Rate limited — wait then try next model
      if (status === 429) {
        const waitSec = errBody?.error?.details
          ?.find(d => d["@type"]?.includes("RetryInfo"))
          ?.retryDelay?.replace("s", "") || 12;
        const waitMs = parseInt(waitSec) * 1000;
        console.log(`[Gemini] 429 on ${model} — waiting ${waitMs/1000}s then switching model`);
        await sleep(waitMs);
        lastError = "rate_limit";
        break; // move to next model immediately after one wait
      }

      // Other error — retry once
      lastError = `HTTP ${status}`;
      if (attempt < 2) await sleep(3000);
    }

    if (lastError === "rate_limit" && m < MODELS.length - 1) {
      console.log(`[Gemini] Switching to fallback model: ${MODELS[m + 1]}`);
    }
  }

  // All models exhausted
  return {
    ok: false,
    status: 503,
    error: "All Gemini models are currently rate limited. Please wait 1 minute and try again."
  };
};

/* ══ POST /api/generate ════════════════════════════════════ */
app.post("/api/generate", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text field is required." });

  const truncated = text.trim().slice(0, 8000);
  const prompt    = `Convert this academic content into a learning experience:\n\n${truncated}`;

  try {
    const { ok, result, status, error } = await callGemini(prompt);
    if (!ok) return res.status(status || 500).json({ error });
    return res.json({ result });
  } catch (err) {
    console.error("[/api/generate] unexpected error:", err.message);
    return res.status(500).json({ error: "Unexpected server error. Please try again." });
  }
});

/* ══ POST /api/tts ════════════════════════════════════════ */
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text field is required." });

  const voiceId = process.env.ELEVENLABS_VOICE_ID_PROFESSOR
                || process.env.ELEVENLABS_VOICE_ID
                || "JBFqnCBsd6RMkjVDRZzb";

  try {
    const audioStream = await eleven.textToSpeech.convertAsStream(voiceId, {
      text:           text.slice(0, 3000),
      model_id:       "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      output_format:  "mp3_44100_128",
    });
    res.setHeader("Content-Type",  "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    for await (const chunk of audioStream) res.write(chunk);
    res.end();
    console.log("[/api/tts] ✅ Audio streamed");
  } catch (err) {
    console.error("[/api/tts]", err.message);
    res.status(500).json({ error: err.message || "ElevenLabs TTS error." });
  }
});

/* ══ MongoDB CRUD ══════════════════════════════════════════ */
app.get("/api/lessons", async (_req, res) => {
  try { res.json(await Lesson.find().sort({ createdAt: -1 }).lean()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/lessons", async (req, res) => {
  try { res.status(201).json(await Lesson.create(req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.put("/api/lessons/:id", async (req, res) => {
  try {
    const l = await Lesson.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!l) return res.status(404).json({ error: "Not found." });
    res.json(l);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/api/lessons/:id", async (req, res) => {
  try { await Lesson.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

/* ══ Health ════════════════════════════════════════════════ */
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    models: MODELS,
    db:     mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.get("*", (req, res) => {
  if (!req.path.startsWith("/api/")) res.sendFile(path.join(__dirname, "index.html"));
});

/* ══ Start ══════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\n🚀  EduAI v2`);
  console.log(`   App:    http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Models: ${MODELS.join(" → ")}\n`);
});
