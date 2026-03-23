/**
 * db.js — EduAI v2  Client-Side Database
 */

const DB = (() => {
  const NS = "eduai2_";
  const BACKEND = "http://localhost:4000";

  const key  = (id) => `${NS}${id}`;
  const safe = (s)  => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

  const save = async (lesson) => {
    if (!lesson?.localId) return false;
    lesson.synced = false;
    try { localStorage.setItem(key(lesson.localId), JSON.stringify(lesson)); } catch { return false; }
    _syncToMongo(lesson).catch(() => {});
    return true;
  };

  const load = (localId) => safe(localStorage.getItem(key(localId)));

  const remove = async (localId) => {
    const lesson = load(localId);
    localStorage.removeItem(key(localId));
    if (lesson?._id) {
      try { await fetch(`${BACKEND}/api/lessons/${lesson._id}`, { method: "DELETE" }); } catch {}
    }
  };

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

  const count = () => list().length;

  const patch = (localId, fields) => {
    const lesson = load(localId);
    if (!lesson) return;
    Object.assign(lesson, fields);
    try { localStorage.setItem(key(localId), JSON.stringify(lesson)); } catch {}
  };

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
    patch(lesson.localId, { _id: saved._id, synced: true });
  };

  return { save, load, remove, list, count, patch, syncFromMongo };
})();

window.DB = DB;
