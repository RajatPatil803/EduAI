/**
 * db.js — EduAI v2  Client-Side Database
 * ─────────────────────────────────────────────────────────────
 * Wraps localStorage for offline/fast access.
 * Every save also syncs to the MongoDB backend via the REST API.
 *
 * Schema per lesson:
 * {
 *   _id:               string  (MongoDB ObjectId string, set after sync)
 *   localId:           string  ("lesson_<timestamp>")
 *   createdAt:         number  (Unix ms)
 *   topic:             string
 *   conversation:      [{speaker, text}]
 *   simple_explanation:string
 *   questions:         {basic:[{q,a}], medium:[{q,a}], advanced:[{q,a}]}
 *   summary:           string[]
 *   visual_suggestions:[{timestamp,description,type}]
 *   audio_script:      {student:string[], professor:string[]}
 *   audioUrl:          string | null   (ElevenLabs TTS url)
 *   synced:            boolean
 * }
 * ─────────────────────────────────────────────────────────────
 */

const DB = (() => {
  const NS = "eduai2_";
  const BACKEND = "http://localhost:4000";

  /* ── helpers ── */
  const key  = (id) => `${NS}${id}`;
  const safe = (s)  => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

  /* ── CRUD ── */

  /** Save lesson locally. Attempt async MongoDB sync. */
  const save = async (lesson) => {
    if (!lesson?.localId) return false;
    lesson.synced = false;
    try { localStorage.setItem(key(lesson.localId), JSON.stringify(lesson)); } catch { return false; }

    // Async sync to MongoDB — don't await, don't block UI
    _syncToMongo(lesson).catch(() => {});
    return true;
  };

  /** Load single lesson by localId */
  const load = (localId) => safe(localStorage.getItem(key(localId)));

  /** Delete lesson locally and from MongoDB */
  const remove = async (localId) => {
    const lesson = load(localId);
    localStorage.removeItem(key(localId));
    if (lesson?._id) {
      try { await fetch(`${BACKEND}/api/lessons/${lesson._id}`, { method: "DELETE" }); } catch {}
    }
  };

  /** List all lessons newest-first */
  const list = () => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(`${NS}lesson_`)) {
        const p = safe(localStorage.getItem(k));
        if (p) out.push(p);
      }
    }
    return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  };

  /** Count lessons */
  const count = () => list().length;

  /** Update a single field on a cached lesson */
  const patch = (localId, fields) => {
    const lesson = load(localId);
    if (!lesson) return;
    Object.assign(lesson, fields);
    try { localStorage.setItem(key(localId), JSON.stringify(lesson)); } catch {}
  };

  /** Pull all lessons from MongoDB and merge into localStorage */
  const syncFromMongo = async () => {
    try {
      const res  = await fetch(`${BACKEND}/api/lessons`);
      if (!res.ok) return;
      const data = await res.json();
      data.forEach((lesson) => {
        lesson.localId = lesson.localId || `lesson_${lesson.createdAt}`;
        lesson.synced  = true;
        try { localStorage.setItem(key(lesson.localId), JSON.stringify(lesson)); } catch {}
      });
    } catch {}
  };

  /* ── private ── */

  const _syncToMongo = async (lesson) => {
    const method = lesson._id ? "PUT"  : "POST";
    const url    = lesson._id
      ? `${BACKEND}/api/lessons/${lesson._id}`
      : `${BACKEND}/api/lessons`;

    const res  = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lesson),
    });
    if (!res.ok) return;
    const saved = await res.json();
    // Store returned MongoDB _id locally
    patch(lesson.localId, { _id: saved._id, synced: true });
  };

  return { save, load, remove, list, count, patch, syncFromMongo };
})();

window.DB = DB;