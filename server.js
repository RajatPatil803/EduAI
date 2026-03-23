/**
 * server.js — EduAI v2
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const crypto     = require("crypto");
const mongoose   = require("mongoose");
const { ElevenLabsClient } = require("elevenlabs");

/* ══════════════════════════════════════════════════════════════
   1. GEMINI KEY POOL
══════════════════════════════════════════════════════════════ */
const buildKeyPool = () => {
  const keys = [];
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k?.startsWith("AIza")) keys.push({ key: k, id: i, callsThisMin: 0, resetAt: 0 });
  }
  if (keys.length === 0) {
    const k = process.env.GEMINI_API_KEY;
    if (k?.startsWith("AIza")) keys.push({ key: k, id: 0, callsThisMin: 0, resetAt: 0 });
  }
  if (keys.length === 0) {
    console.error("\n❌  No Gemini API keys found!");
    console.error("   Add GEMINI_API_KEY_1, GEMINI_API_KEY_2 ... to your .env\n");
    process.exit(1);
  }
  console.log(`✅  Gemini key pool: ${keys.length} key(s) loaded`);
  return keys;
};

const KEY_POOL  = buildKeyPool();
const RPM_LIMIT = 8;
const MODEL     = "gemini-2.5-flash";

let _poolIndex = 0;

/* ══════════════════════════════════════════════════════════════
   2. KEY ROTATION LOGIC
══════════════════════════════════════════════════════════════ */
const getNextKey = () => {
  const now = Date.now();
  KEY_POOL.forEach(k => {
    if (now >= k.resetAt) { k.callsThisMin = 0; k.resetAt = now + 60_000; }
  });
  for (let i = 0; i < KEY_POOL.length; i++) {
    const idx = (_poolIndex + i) % KEY_POOL.length;
    const k   = KEY_POOL[idx];
    if (k.callsThisMin < RPM_LIMIT) {
      _poolIndex = (idx + 1) % KEY_POOL.length;
      k.callsThisMin++;
      console.log(`[Pool] Using key #${k.id} (${k.callsThisMin}/${RPM_LIMIT} calls this min)`);
      return { key: k.key, available: true, waitMs: 0 };
    }
  }
  const soonestReset = Math.min(...KEY_POOL.map(k => k.resetAt));
  const waitMs       = Math.max(0, soonestReset - now) + 500;
  console.log(`[Pool] All keys at limit. Next slot in ${(waitMs / 1000).toFixed(1)}s`);
  return { key: null, available: false, waitMs };
};

const markKeyRateLimited = (keyValue, retryAfterSec = 60) => {
  const k = KEY_POOL.find(k => k.key === keyValue);
  if (k) {
    k.callsThisMin = RPM_LIMIT;
    k.resetAt      = Date.now() + retryAfterSec * 1000;
    console.log(`[Pool] Key #${k.id} rate limited — reset in ${retryAfterSec}s`);
  }
};

/* ══════════════════════════════════════════════════════════════
   3. RESPONSE CACHE
══════════════════════════════════════════════════════════════ */
const CACHE     = new Map();
const CACHE_MAX = 200;

const cacheKey = (text, mode) =>
  crypto.createHash("md5").update(`${mode}::${text.slice(0, 500)}`).digest("hex");

const cacheGet = (key) => {
  const entry = CACHE.get(key);
  if (!entry) return null;
  console.log(`[Cache] ✅ HIT — serving from cache (no API call)`);
  return entry.result;
};

const cacheSet = (key, result) => {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { result, ts: Date.now() });
};

/* ══════════════════════════════════════════════════════════════
   4. ENVIRONMENT & SERVICES
══════════════════════════════════════════════════════════════ */
if (!process.env.MONGO_URI)          { console.error("❌  Missing: MONGO_URI");          process.exit(1); }
if (!process.env.ELEVENLABS_API_KEY) { console.error("❌  Missing: ELEVENLABS_API_KEY"); process.exit(1); }

const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅  MongoDB connected"))
  .catch((e) => { console.error("❌  MongoDB:", e.message); process.exit(1); });

/* ══════════════════════════════════════════════════════════════
   5. MONGODB SCHEMA
══════════════════════════════════════════════════════════════ */
const lessonSchema = new mongoose.Schema({
  localId:            { type: String, index: true },
  learningMode:       { type: String, default: "student", enum: ["student","kids","exam"] },
  topic:              { type: String, required: true },
  conversation:       [{ speaker: String, text: String }],
  simple_explanation: String,
  questions: {
    basic:    [{ q: String, a: String }],
    medium:   [{ q: String, a: String }],
    advanced: [{ q: String, a: String }],
  },
  summary: [String],
  cheatsheet: {
    key_terms:     [{ term: String, definition: String }],
    core_concepts: [String],
    quick_qa:      [{ q: String, a: String }],
    formulas:      [{ label: String, value: String }],
    memory_tips:   [String],
  },
  visual_suggestions: [{ timestamp: String, description: String, type: String }],
  audio_script:       { student: [String], professor: [String] },
  audioUrl:           { type: String, default: null },
  synced:             { type: Boolean, default: true },
  createdAt:          { type: Number, default: () => Date.now() },
}, { timestamps: true });

const Lesson = mongoose.model("Lesson", lessonSchema);

/* ══════════════════════════════════════════════════════════════
   6. PROMPTS (mode-aware)
══════════════════════════════════════════════════════════════ */
const MODE_RULES = {
  student: `- conversation: 12-14 exchanges, balanced depth, engaging
- language: clear, avoids jargon, uses analogies
- questions: basic=recall, medium=comprehension, advanced=application
- cheatsheet: balanced key terms, core concepts, and Q&A`,

  kids: `- conversation: 10-12 exchanges, VERY simple words (age 8-12)
- use fun analogies: toys, games, food, animals
- zero technical jargon — explain every term immediately
- questions: all recall-level, fun and encouraging
- cheatsheet: short sentences, fun language`,

  exam: `- conversation: 14-16 exchanges, precise technical language
- include definitions, formulas, edge cases, exam traps
- questions: basic=exact definitions, medium=application, advanced=synthesis
- cheatsheet: dense with formulas, exact definitions, memory tricks`,
};

const buildPrompt = (mode) => `You are an educational AI. Generate a JSON learning experience for "${mode.toUpperCase()}" mode.

Return ONLY a valid JSON object — no markdown, no preamble, no explanation:
{
  "topic": "string",
  "conversation": [{"speaker":"Student","text":"string"},{"speaker":"Professor","text":"string"}],
  "simple_explanation": "string",
  "questions": {
    "basic":    [{"q":"string","a":"string"},{"q":"string","a":"string"},{"q":"string","a":"string"}],
    "medium":   [{"q":"string","a":"string"},{"q":"string","a":"string"},{"q":"string","a":"string"}],
    "advanced": [{"q":"string","a":"string"},{"q":"string","a":"string"}]
  },
  "summary": ["string","string","string","string","string"],
  "cheatsheet": {
    "key_terms":    [{"term":"string","definition":"string"}],
    "core_concepts":["string","string","string","string","string"],
    "quick_qa":     [{"q":"string","a":"string"},{"q":"string","a":"string"},{"q":"string","a":"string"}],
    "formulas":     [{"label":"string","value":"string"}],
    "memory_tips":  ["string","string","string"]
  },
  "visual_suggestions": [{"timestamp":"string","description":"string","type":"string"}],
  "audio_script": {"student":["string"],"professor":["string"]}
}

${mode.toUpperCase()} mode rules:
${MODE_RULES[mode]}

General: summary = exactly 5 strings, cheatsheet.formulas = [] if no formulas apply.`;

/* ══════════════════════════════════════════════════════════════
   7. GEMINI CALL
   options.allowPlainText = true  → skip JSON validation (for Q&A)
   options.allowPlainText = false → validate JSON (for lesson gen)
══════════════════════════════════════════════════════════════ */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const geminiUrl = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

const callGemini = async (userPrompt, systemPrompt, options = {}) => {
  const { allowPlainText = false } = options;
  const maxAttempts = KEY_POOL.length * 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { key, available, waitMs } = getNextKey();

    if (!available) {
      console.log(`[Gemini] All keys busy — waiting ${(waitMs / 1000).toFixed(1)}s`);
      await sleep(waitMs);
      const slot = getNextKey();
      if (!slot.available) continue;
    }

    const useKey = key || getNextKey().key;
    if (!useKey) { await sleep(3000); continue; }

    console.log(`[Gemini] Calling ${MODEL} (attempt ${attempt + 1})`);

    try {
      const res = await fetch(geminiUrl(useKey), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents:           [{ parts: [{ text: userPrompt  }] }],
          generationConfig: {
            temperature:     0.7,
            maxOutputTokens: 6000,
          },
        }),
      });

      /* ── Success ── */
      if (res.ok) {
        const data = await res.json();
        let raw    = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!raw) { console.warn("[Gemini] Empty response"); continue; }

        // Strip markdown fences
        raw = raw.replace(/^```json\s*/im, "").replace(/^```\s*/im, "").replace(/```\s*$/im, "").trim();

        // Plain text allowed (Q&A routes) — return immediately
        if (allowPlainText) {
          const fb = raw.indexOf("{");
          const lb = raw.lastIndexOf("}");
          if (fb !== -1 && lb > fb) {
            const candidate = raw.slice(fb, lb + 1).replace(/,\s*([}\]])/g, "$1");
            try { JSON.parse(candidate); raw = candidate; } catch { /* keep raw text */ }
          }
          console.log(`[Gemini] ✅ Success (text) — ${raw.length} chars`);
          return { ok: true, result: raw };
        }

        // JSON-only path (lesson generation)
        const fb = raw.indexOf("{");
        const lb = raw.lastIndexOf("}");
        if (fb !== -1 && lb > fb) raw = raw.slice(fb, lb + 1);
        raw = raw.replace(/,\s*([}\]])/g, "$1");

        try {
          JSON.parse(raw);
          console.log(`[Gemini] ✅ Success (JSON) — ${raw.length} chars`);
          return { ok: true, result: raw };
        } catch {
          console.error("[Gemini] ❌ Invalid JSON:", raw.slice(0, 150));
          continue;
        }
      }

      /* ── Rate limit ── */
      if (res.status === 429) {
        const errBody    = await res.json().catch(() => ({}));
        const retryAfter = parseInt(
          errBody?.error?.details
            ?.find(d => d["@type"]?.includes("RetryInfo"))
            ?.retryDelay?.replace("s", "") || "60"
        );
        markKeyRateLimited(useKey, retryAfter);
        continue;
      }

      /* ── Auth error ── */
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: 401, error: "Invalid Gemini API key. Check your .env file." };
      }

      console.error(`[Gemini] HTTP ${res.status}`);
      await sleep(2000);

    } catch (networkErr) {
      console.error("[Gemini] Network error:", networkErr.message);
      await sleep(2000);
    }
  }

  return { ok: false, status: 503, error: "Gemini API is currently busy. Please wait 60 seconds and try again." };
};

/* ══════════════════════════════════════════════════════════════
   8. EXPRESS APP
══════════════════════════════════════════════════════════════ */
const app  = express();
const PORT = process.env.PORT || 4000;
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

/* ── POST /api/generate ─────────────────────────────────── */
app.post("/api/generate", async (req, res) => {
  const { text, mode = "student" } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text is required." });
  if (!["student","kids","exam"].includes(mode))
    return res.status(400).json({ error: "mode must be: student, kids, or exam." });

  const truncated = text.trim().slice(0, 8000);
  console.log(`\n[/generate] mode=${mode} chars=${truncated.length}`);

  const ck     = cacheKey(truncated, mode);
  const cached = cacheGet(ck);
  if (cached) return res.json({ result: cached, mode, fromCache: true });

  const sysPrompt  = buildPrompt(mode);
  const userPrompt = `Convert this academic content into a ${mode} learning experience:\n\n${truncated}`;

  const { ok, result, status, error } = await callGemini(userPrompt, sysPrompt);
  if (!ok) return res.status(status || 500).json({ error });

  cacheSet(ck, result);
  return res.json({ result, mode, fromCache: false });
});

/* ── POST /api/tts ──────────────────────────────────────── */
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text is required." });

  const voiceId = process.env.ELEVENLABS_VOICE_ID_PROFESSOR || "JBFqnCBsd6RMkjVDRZzb";
  try {
    const stream = await eleven.textToSpeech.convertAsStream(voiceId, {
      text:           text.slice(0, 3000),
      model_id:       "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      output_format:  "mp3_44100_128",
    });
    res.setHeader("Content-Type",  "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    for await (const chunk of stream) res.write(chunk);
    res.end();
  } catch (err) {
    const s = err.statusCode || err.status || 500;
    if (s === 401) return res.status(401).json({ error: "ElevenLabs key invalid — update in Render." });
    if (s === 429) return res.status(429).json({ error: "ElevenLabs character limit reached." });
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/generate-qa ──────────────────────────────── */
app.post("/api/generate-qa", async (req, res) => {
  const { question, context } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: "question is required." });

  const sysPrompt = `You are a helpful professor. The student has just studied a lesson and is asking a follow-up question.
Answer clearly, concisely (2-4 sentences), and in a friendly teaching style.
Use the lesson context provided to give a relevant, accurate answer.
Never make up facts. If unsure, say so.
Return plain text only — no JSON, no markdown, no bullet points.`;

  const userPrompt = `Lesson context:\n${context || ""}\n\nStudent question: ${question}`;

  const { ok, result, status, error } = await callGemini(userPrompt, sysPrompt, { allowPlainText: true });
  if (!ok) return res.status(status || 500).json({ error });

  let answer = result;
  try {
    const parsed = JSON.parse(result);
    answer = parsed.answer || parsed.text || parsed.response || result;
  } catch { /* plain text — use as-is */ }

  return res.json({ answer: String(answer).replace(/[*_`#]/g, "").trim() });
});

/* ── POST /api/qa ───────────────────────────────────────── */
app.post("/api/qa", async (req, res) => {
  const { question, topic, context } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: "question is required." });

  const sysPrompt = `You are a helpful professor answering a student's question about "${topic || "this topic"}".
Give a clear, concise answer in 2-4 sentences. Be educational and encouraging.
If the question is unrelated to the topic, gently redirect back to the lesson content.
Return plain text only — no JSON, no markdown formatting.`;

  const userPrompt = `Context: ${(context || "").slice(0, 1000)}\n\nStudent question: ${question.trim()}`;

  const { ok, result, status, error } = await callGemini(userPrompt, sysPrompt, { allowPlainText: true });
  if (!ok) return res.status(status || 500).json({ error });

  let answer = result;
  try {
    const parsed = JSON.parse(result);
    answer = parsed.answer || parsed.text || parsed.response || result;
  } catch { /* plain text — use as is */ }

  return res.json({ answer: answer.replace(/[*_`#]/g, "").trim() });
});

/* ── MongoDB CRUD ────────────────────────────────────────── */
app.get("/api/lessons", async (_, r) => {
  try { r.json(await Lesson.find().sort({ createdAt: -1 }).lean()); }
  catch (e) { r.status(500).json({ error: e.message }); }
});
app.post("/api/lessons", async (q, r) => {
  try { r.status(201).json(await Lesson.create(q.body)); }
  catch (e) { r.status(400).json({ error: e.message }); }
});
app.put("/api/lessons/:id", async (q, r) => {
  try {
    const l = await Lesson.findByIdAndUpdate(q.params.id, q.body, { new: true });
    if (!l) return r.status(404).json({ error: "Not found" });
    r.json(l);
  } catch (e) { r.status(400).json({ error: e.message }); }
});
app.delete("/api/lessons/:id", async (q, r) => {
  try { await Lesson.findByIdAndDelete(q.params.id); r.json({ ok: true }); }
  catch (e) { r.status(400).json({ error: e.message }); }
});

/* ── Health ──────────────────────────────────────────────── */
app.get("/api/health", (_, r) => r.json({
  status:    "ok",
  model:     MODEL,
  keys:      KEY_POOL.length,
  cacheSize: CACHE.size,
  db:        mongoose.connection.readyState === 1 ? "connected" : "disconnected",
}));

/* ── Cache stats ─────────────────────────────────────────── */
app.get("/api/cache", (_, r) => r.json({
  size:    CACHE.size,
  maxSize: CACHE_MAX,
  keys:    [...CACHE.keys()].map(k => k.slice(0, 8) + "..."),
}));

/* ── Catch-all → index.html ──────────────────────────────── */
app.get("*", (q, r) => {
  if (!q.path.startsWith("/api/")) r.sendFile(path.join(__dirname, "index.html"));
});

/* ══════════════════════════════════════════════════════════════
   9. START SERVER + KEEP-ALIVE PING
══════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\n🚀  EduAI v2  →  http://localhost:${PORT}`);
  console.log(`   Model:  ${MODEL}`);
  console.log(`   Keys:   ${KEY_POOL.length} (${KEY_POOL.length * RPM_LIMIT} RPM total capacity)`);
  console.log(`   Cache:  up to ${CACHE_MAX} results`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);

  // ── Keep-alive: ping /api/health every 14 minutes ──
  // Prevents Render free tier from spinning down due to inactivity
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      const res = await fetch(`${RENDER_URL}/api/health`);
      if (res.ok) console.log("[Keep-alive] ✅ Server pinged successfully");
      else        console.log("[Keep-alive] ⚠️  Ping returned:", res.status);
    } catch (e) {
      console.log("[Keep-alive] ❌ Ping failed:", e.message);
    }
  }, 14 * 60 * 1000); // 14 minutes
});
