/**
 * api.js — EduAI v2  Frontend API Layer
 */

const API = (() => {
  const BASE = "";

  const _json = (raw) => {
    let clean = raw
      .replace(/^```json\s*/im, "").replace(/^```\s*/im, "").replace(/```\s*$/im, "").trim();
    const fb = clean.indexOf("{"), lb = clean.lastIndexOf("}");
    if (fb !== -1 && lb > fb) clean = clean.slice(fb, lb + 1);
    clean = clean.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(clean);
  };

  const _validate = (obj) => {
    ["topic","conversation","simple_explanation","questions","summary"].forEach((f) => {
      if (!obj[f]) throw new Error(`AI response missing: "${f}"`);
    });
    if (!obj.cheatsheet) obj.cheatsheet = { key_terms:[], core_concepts:[], quick_qa:[], formulas:[], memory_tips:[] };
  };

  const generateLesson = async (text, onProgress, mode = "student") => {
    if (!text?.trim()) throw new Error("No text provided.");
    onProgress?.(10);
    let res;
    try {
      res = await fetch(`${BASE}/api/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim().slice(0, 8000), mode }),
      });
    } catch { throw new Error("Cannot reach the server."); }
    onProgress?.(55);
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || `Server error ${res.status}`); }
    const data = await res.json();
    onProgress?.(85);
    if (!data.result) throw new Error("Empty response from server.");
    let lesson;
    try { lesson = _json(data.result); } catch { throw new Error("AI returned invalid format — try again."); }
    _validate(lesson);
    onProgress?.(100);
    return lesson;
  };

  const generateAudio = async (lessonId, text) => {
    const res = await fetch(`${BASE}/api/tts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId, text: text.slice(0, 3000) }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || `TTS error ${res.status}`); }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  };

  const health = async () => {
    try { const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) }); return r.ok; }
    catch { return false; }
  };

  const askQuestion = async (question, topic, context) => {
    const res = await fetch(`${BASE}/api/generate-qa`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, context: `Topic: ${topic}\n${context}` }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || `QA error ${res.status}`); }
    const data = await res.json();
    return data.answer || "Sorry, I couldn't answer that right now.";
  };

  const _readAsText = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = (e) => res(e.target.result || "");
    r.onerror = ()  => rej(new Error("Could not read file."));
    r.readAsText(file);
  });

  const _readPDF = (file) => new Promise((resolve, reject) => {
    const tryExtract = () => {
      const lib = window["pdfjs-dist/build/pdf"];
      if (!lib) { reject(new Error("pdf.js failed to load.")); return; }
      lib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      file.arrayBuffer().then(buf => lib.getDocument({ data: buf }).promise)
        .then(async (pdf) => {
          let text = "";
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const c    = await page.getTextContent();
            text += c.items.map(it => it.str).join(" ") + "\n";
          }
          const clean = text.replace(/\s+/g, " ").trim();
          clean ? resolve(clean) : reject(new Error("No text in PDF. Try pasting instead."));
        }).catch(e => reject(new Error("PDF read error: " + e.message)));
    };

    if (window["pdfjs-dist/build/pdf"]) { tryExtract(); return; }
    const s = document.createElement("script");
    s.src    = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = tryExtract;
    s.onerror = () => reject(new Error("Could not load PDF reader."));
    document.head.appendChild(s);
  });

  const _readDOCX = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const str = new TextDecoder("utf-8", { fatal: false })
          .decode(new Uint8Array(e.target.result));
        let text = (str.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [])
          .map(m => m.replace(/<[^>]+>/g, "")).join(" ");
        if (!text.trim()) text = str.replace(/<[^>]+>/g, " ").replace(/[^\x20-\x7E\s]/g, " ").replace(/\s+/g, " ").trim();
        text.trim() ? resolve(text) : reject(new Error("No text found in Word file."));
      } catch { reject(new Error("Could not read Word file.")); }
    };
    r.onerror = () => reject(new Error("File read error."));
    r.readAsArrayBuffer(file);
  });

  const _readPPTX = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const str = new TextDecoder("utf-8", { fatal: false })
          .decode(new Uint8Array(e.target.result));
        let text = (str.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [])
          .map(m => m.replace(/<[^>]+>/g, "")).join(" ");
        if (!text.trim()) text = str.replace(/<[^>]+>/g, " ").replace(/[^\x20-\x7E\s]/g, " ").replace(/\s+/g, " ").trim();
        text.trim() ? resolve(text) : reject(new Error("No text found in PowerPoint file."));
      } catch { reject(new Error("Could not read PowerPoint file.")); }
    };
    r.onerror = () => reject(new Error("File read error."));
    r.readAsArrayBuffer(file);
  });

  const readFile = async (file) => {
    const ext = file.name.toLowerCase().split(".").pop();
    const CODE_EXTS = new Set([
      "txt","md","c","cpp","h","hpp","java","py","js","ts","jsx","tsx",
      "html","htm","css","json","xml","csv","cs","go","rb","php","swift",
      "kt","rs","sh","bash","yaml","yml","sql","r","m","scala","pl","lua",
      "dart","vue","svelte","toml","ini","env","Makefile","gradle"
    ]);
    if (CODE_EXTS.has(ext) || file.type.startsWith("text/")) return _readAsText(file);
    if (ext === "pdf")                   return _readPDF(file);
    if (ext === "docx" || ext === "doc") return _readDOCX(file);
    if (ext === "pptx" || ext === "ppt") return _readPPTX(file);
    return _readAsText(file);
  };

  return { generateLesson, generateAudio, health, askQuestion, readFile };
})();

window.API = API;
