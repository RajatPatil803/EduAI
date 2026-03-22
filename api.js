/**
 * api.js — EduAI v2  Frontend API Layer
 * ─────────────────────────────────────────────────────────────
 * Uses RELATIVE URLs so it works both locally AND on Render/any host.
 * Never hardcode localhost — the server serves the frontend too.
 * ─────────────────────────────────────────────────────────────
 */

const API = (() => {

  // RELATIVE base — works on localhost AND on Render/production
  // Do NOT use "http://localhost:4000" — breaks on deployed server
  const BASE = "";

  /* ── JSON parser — robust extraction from any AI response ── */
  const _json = (raw) => {
    // Strategy 1: strip markdown fences then parse
    let clean = raw
      .replace(/^```json\s*/im, "")
      .replace(/^```\s*/im, "")
      .replace(/```\s*$/im, "")
      .trim();

    // Strategy 2: find the first { and last } — extract just the JSON object
    // This handles cases where Gemini adds preamble text before or after the JSON
    const firstBrace = clean.indexOf("{");
    const lastBrace  = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      clean = clean.slice(firstBrace, lastBrace + 1);
    }

    // Strategy 3: fix common JSON issues Gemini introduces
    // Remove trailing commas before } or ]  (invalid JSON)
    clean = clean.replace(/,\s*([}\]])/g, "$1");

    return JSON.parse(clean);
  };

  const _validate = (obj) => {
    ["topic","conversation","simple_explanation","questions","summary"].forEach((f) => {
      if (!obj[f]) throw new Error(`AI response missing field: "${f}"`);
    });
    // Ensure cheatsheet exists (may be missing in older lessons)
    if (!obj.cheatsheet) {
      obj.cheatsheet = {
        key_terms: [], core_concepts: [], quick_qa: [], formulas: [], memory_tips: []
      };
    }
  };

  /* ── Generate lesson ── */
  const generateLesson = async (text, onProgress, mode = "student") => {
    if (!text?.trim()) throw new Error("No text provided.");
    onProgress?.(10);

    let res;
    try {
      res = await fetch(`${BASE}/api/generate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ text: text.trim().slice(0, 8000), mode }),
      });
    } catch (err) {
      throw new Error("Cannot reach the server. Make sure it is running.");
    }

    onProgress?.(55);

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Server error ${res.status}`);
    }

    const data = await res.json();
    onProgress?.(85);

    if (!data.result) throw new Error("Empty response from server.");

    let lesson;
    try { lesson = _json(data.result); }
    catch { throw new Error("AI returned invalid format — please try again."); }

    _validate(lesson);
    onProgress?.(100);
    return lesson;
  };

  /* ── Generate TTS audio ── */
  const generateAudio = async (lessonId, text) => {
    const res = await fetch(`${BASE}/api/tts`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ lessonId, text: text.slice(0, 3000) }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `TTS error ${res.status}`);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  };

  /* ── Health check ── */
  const health = async () => {
    try {
      const res = await fetch(`${BASE}/api/health`, {
        signal: AbortSignal.timeout(4000)
      });
      return res.ok;
    } catch { return false; }
  };

  /* ── Read plain text file ── */
  const readText = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = (e) => resolve(e.target.result || "");
    r.onerror = ()  => reject(new Error("Could not read file."));
    r.readAsText(file);
  });

  /* ── Read PDF using pdf.js (proper extraction) ── */
  const readPDF = (file) => new Promise((resolve, reject) => {
    // Use pdf.js CDN for proper text extraction
    const script = document.getElementById("pdfjs-script");
    const load   = () => _extractPDF(file, resolve, reject);

    if (window["pdfjs-dist/build/pdf"]) {
      load();
    } else if (!script) {
      const s  = document.createElement("script");
      s.id     = "pdfjs-script";
      s.src    = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = load;
      s.onerror = () => {
        // Fallback: basic ASCII extraction if pdf.js fails to load
        _extractPDFBasic(file, resolve, reject);
      };
      document.head.appendChild(s);
    } else {
      // Script tag exists but not loaded yet — wait
      script.addEventListener("load", load);
    }
  });

  const _extractPDF = async (file, resolve, reject) => {
    try {
      const pdfjsLib = window["pdfjs-dist/build/pdf"];
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

      const arrayBuffer = await file.arrayBuffer();
      const pdf         = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let   fullText    = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page    = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => item.str).join(" ");
        fullText += pageText + "\n";
      }

      const clean = fullText.replace(/\s+/g, " ").trim();
      if (!clean) reject(new Error("No text found in PDF. Try pasting the text instead."));
      else        resolve(clean);
    } catch (err) {
      reject(new Error("Failed to read PDF: " + err.message));
    }
  };

  const _extractPDFBasic = (file, resolve, reject) => {
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
        resolve(t.replace(/\s+/g, " ").trim());
      } catch { reject(new Error("Could not parse PDF. Paste the text instead.")); }
    };
    r.onerror = () => reject(new Error("Could not read file."));
    r.readAsArrayBuffer(file);
  };

  return { generateLesson, generateAudio, health, readText, readPDF };
})();

window.API = API;
