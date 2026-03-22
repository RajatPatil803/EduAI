/**
 * server.js — EduAI v2
 * Features: Learning Mode (kids/student/exam), Cheat Sheet, Gemini cascade
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const mongoose   = require("mongoose");
const { ElevenLabsClient } = require("elevenlabs");
const rateLimit  = require("express-rate-limit");

/* ══ Validate env ══════════════════════════════════════════ */
["GEMINI_API_KEY","MONGO_URI","ELEVENLABS_API_KEY"].forEach((k) => {
  if (!process.env[k]) { console.error(`\n❌  Missing: ${k}\n`); process.exit(1); }
});

/* ══ Gemini models (cascade on rate limit) ═════════════════ */
const MODELS = [
  "gemini-1.5-flash",        // stable, 15 RPM, 1500 RPD free
  "gemini-1.5-flash-8b",     // fastest fallback, 15 RPM free
  "gemini-2.0-flash",        // newest stable fallback
];
const geminiUrl = (m) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${process.env.GEMINI_API_KEY}`;

/* ══ ElevenLabs ════════════════════════════════════════════ */
const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

/* ══ MongoDB ═══════════════════════════════════════════════ */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅  MongoDB connected"))
  .catch((e) => { console.error("❌  MongoDB:", e.message); process.exit(1); });

const lessonSchema = new mongoose.Schema({
  localId:            { type: String, index: true },
  learningMode:       { type: String, default: "student", enum: ["student","kids","exam"] },
  topic:              { type: String, required: true },
  conversation:       [{ speaker: String, text: String }],
  simple_explanation: String,
  questions:          { basic: [{ q:String, a:String }], medium: [{ q:String, a:String }], advanced: [{ q:String, a:String }] },
  summary:            [String],
  cheatsheet: {
    key_terms:    [{ term: String, definition: String }],
    core_concepts:[String],
    quick_qa:     [{ q: String, a: String }],
    formulas:     [{ label: String, value: String }],
    memory_tips:  [String],
  },
  visual_suggestions: [{ timestamp: String, description: String, type: String }],
  audio_script:       { student: [String], professor: [String] },
  audioUrl:           { type: String, default: null },
  synced:             { type: Boolean, default: true },
  createdAt:          { type: Number, default: () => Date.now() },
}, { timestamps: true });

const Lesson = mongoose.model("Lesson", lessonSchema);

/* ══ Mode-aware prompts ════════════════════════════════════ */
const MODE_CONFIG = {
  student: {
    label: "Student",
    rules: `- conversation: 12-16 exchanges, balanced depth, engaging
- language: clear, helpful analogies, minimal jargon
- questions: basic=recall, medium=comprehension, advanced=application
- cheatsheet: balanced key terms, core concepts, exam-ready Q&A`,
  },
  kids: {
    label: "Kids",
    rules: `- conversation: 10-12 exchanges, VERY simple words (age 8-12 level)
- use fun analogies: toys, games, food, animals, cartoons
- zero technical jargon — explain any term immediately in simple words
- questions: all recall-level, fun, encouraging, no trick questions
- cheatsheet: only essential points, very short sentences, fun language`,
  },
  exam: {
    label: "Exam",
    rules: `- conversation: 14-18 exchanges, precise technical language, exam-focused
- include definitions, formulas, edge cases, common exam traps
- questions: basic=exact definitions, medium=application with working, advanced=synthesis+analysis
- cheatsheet: dense with formulas, exact definitions, key distinctions, mnemonics
- memory_tips: include 3 exam-strategy tips (e.g. how to remember, common mistakes)`,
  },
};

const buildPrompt = (mode = "student") => {
  const cfg = MODE_CONFIG[mode] || MODE_CONFIG.student;
  return `You are an intelligent educational AI. Generate a structured JSON learning experience for "${mode.toUpperCase()}" mode.

Return ONLY valid JSON — no markdown fences, no preamble:
{
  "topic": "string",
  "conversation": [{"speaker":"Student","text":"..."},{"speaker":"Professor","text":"..."}],
  "simple_explanation": "string",
  "questions": {
    "basic":    [{"q":"...","a":"..."},{"q":"...","a":"..."},{"q":"...","a":"..."}],
    "medium":   [{"q":"...","a":"..."},{"q":"...","a":"..."},{"q":"...","a":"..."}],
    "advanced": [{"q":"...","a":"..."},{"q":"...","a":"..."}]
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

Rules for ${mode.toUpperCase()} mode:
${cfg.rules}

General rules:
- summary: exactly 5 strings
- cheatsheet.key_terms: 4-8 terms
- cheatsheet.formulas: empty array [] if topic has no formulas
- visual_suggestions: 3-6 items with realistic timestamps
- Return ONLY the JSON object`;
};

/* ══ Express ════════════════════════════════════════════════ */
const app  = express();
const PORT = process.env.PORT || 4000;
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));
const limiter = rateLimit({ windowMs:60_000, max:15, message:{error:"Too many requests."} });
app.use("/api/generate", limiter);
app.use("/api/tts",      limiter);

/* ══ Gemini cascade helper ═════════════════════════════════ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const callGemini = async (userPrompt, systemPrompt) => {
  for (let m = 0; m < MODELS.length; m++) {
    const model = MODELS[m];
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`[Gemini] model=${model} attempt=${attempt}`);
      const res = await fetch(geminiUrl(model), {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature:     0.7,
            maxOutputTokens: 6000,
            responseMimeType: "application/json",
          }
        })
      });
      if (res.ok) {
        const data   = await res.json();
        let result   = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        if (result) {
          // Belt-and-suspenders cleanup even with responseMimeType
          const firstBrace = result.indexOf("{");
          const lastBrace  = result.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            result = result.slice(firstBrace, lastBrace + 1);
          }
          result = result.replace(/,\s*([}\]])/g, "$1");

          // Validate it's parseable before returning
          try {
            JSON.parse(result);
            console.log(`[Gemini] ✅ model=${model} chars=${result.length}`);
            return { ok:true, result };
          } catch(parseErr) {
            console.error(`[Gemini] ❌ Invalid JSON from ${model}:`, result.slice(0,200));
            // Don't return — fall through to retry/next model
          }
        }

        console.warn(`[Gemini] ⚠️ Empty or invalid content from ${model}`);
      }
      const status  = res.status;
      const errBody = await res.json().catch(() => ({}));
      if (status === 401 || status === 403) return { ok:false, status:401, error:"Invalid Gemini API key." };
      if (status === 429) {
        const waitSec = errBody?.error?.details?.find(d=>d["@type"]?.includes("RetryInfo"))?.retryDelay?.replace("s","") || 12;
        await sleep(parseInt(waitSec)*1000);
        lastError = "rate_limit"; break;
      }
      lastError = `HTTP ${status}`;
      if (attempt < 2) await sleep(3000);
    }
    if (lastError === "rate_limit" && m < MODELS.length-1) console.log(`[Gemini] switching → ${MODELS[m+1]}`);
  }
  return { ok:false, status:503, error:"All Gemini models rate limited. Wait 1 minute and retry." };
};

/* ══ POST /api/generate ════════════════════════════════════ */
app.post("/api/generate", async (req, res) => {
  const { text, mode = "student" } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text is required." });
  if (!["student","kids","exam"].includes(mode))
    return res.status(400).json({ error: "mode must be student, kids, or exam." });

  const truncated    = text.trim().slice(0, 8000);
  const systemPrompt = buildPrompt(mode);
  const userPrompt   = `Convert this academic content into a ${mode} learning experience:\n\n${truncated}`;

  console.log(`[/api/generate] mode=${mode} chars=${truncated.length}`);

  try {
    const { ok, result, status, error } = await callGemini(userPrompt, systemPrompt);
    if (!ok) return res.status(status||500).json({ error });
    return res.json({ result, mode });
  } catch (err) {
    return res.status(500).json({ error: "Unexpected error. Please try again." });
  }
});

/* ══ POST /api/tts ═════════════════════════════════════════ */
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text is required." });
  const voiceId = process.env.ELEVENLABS_VOICE_ID_PROFESSOR || "JBFqnCBsd6RMkjVDRZzb";
  try {
    const stream = await eleven.textToSpeech.convertAsStream(voiceId, {
      text: text.slice(0,3000), model_id:"eleven_multilingual_v2",
      voice_settings:{ stability:0.5, similarity_boost:0.75 }, output_format:"mp3_44100_128",
    });
    res.setHeader("Content-Type","audio/mpeg");
    res.setHeader("Cache-Control","public, max-age=86400");
    for await (const chunk of stream) res.write(chunk);
    res.end();
  } catch (err) {
    const s = err.statusCode||err.status||500;
    if (s===401) return res.status(401).json({ error:"ElevenLabs key invalid — update in Render environment." });
    if (s===429) return res.status(429).json({ error:"ElevenLabs character limit reached." });
    res.status(500).json({ error: err.message });
  }
});

/* ══ MongoDB CRUD ══════════════════════════════════════════ */
app.get("/api/lessons",       async (_,res) => { try { res.json(await Lesson.find().sort({createdAt:-1}).lean()); } catch(e){ res.status(500).json({error:e.message}); }});
app.post("/api/lessons",      async (req,res) => { try { res.status(201).json(await Lesson.create(req.body)); } catch(e){ res.status(400).json({error:e.message}); }});
app.put("/api/lessons/:id",   async (req,res) => { try { const l=await Lesson.findByIdAndUpdate(req.params.id,req.body,{new:true}); if(!l) return res.status(404).json({error:"Not found"}); res.json(l); } catch(e){ res.status(400).json({error:e.message}); }});
app.delete("/api/lessons/:id",async (req,res) => { try { await Lesson.findByIdAndDelete(req.params.id); res.json({ok:true}); } catch(e){ res.status(400).json({error:e.message}); }});

/* ══ Health ════════════════════════════════════════════════ */
app.get("/api/health", (_,res) => res.json({ status:"ok", models:MODELS, db:mongoose.connection.readyState===1?"connected":"disconnected" }));
app.get("*", (req,res) => { if(!req.path.startsWith("/api/")) res.sendFile(path.join(__dirname,"index.html")); });

/* ══ Start ══════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\n🚀  EduAI v2  http://localhost:${PORT}`);
  console.log(`   Modes:  Kids · Student · Exam`);
  console.log(`   Models: ${MODELS.join(" → ")}\n`);
});
