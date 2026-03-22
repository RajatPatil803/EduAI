/**
 * app.js — EduAI v2  Application Logic
 * ─────────────────────────────────────────────────────────────
 * Handles view routing, rendering, events, audio player.
 * Depends on: db.js (window.DB)  api.js (window.API)
 * ─────────────────────────────────────────────────────────────
 */

(() => {
  "use strict";

  /* ══ 1. DOM refs ══════════════════════════════════════════ */
  const $ = (id) => document.getElementById(id);

  const EL = {
    // views
    viewHome: $("viewHome"), viewLibrary: $("viewLibrary"), viewLesson: $("viewLesson"),
    // navbar
    btnLogo: $("btnLogo"), btnNavHome: $("btnNavHome"), btnNavLibrary: $("btnNavLibrary"),
    navCount: $("navCount"), navProgress: $("navProgress"), navProgressFill: $("navProgressFill"),
    // toast
    toast: $("toast"), toastText: $("toastText"), toastClose: $("toastClose"),
    // home
    modePaste: $("modePaste"), modeFile: $("modeFile"),
    panelPaste: $("panelPaste"), panelFile: $("panelFile"),
    inputText: $("inputText"), charCount: $("charCount"),
    btnGenerate: $("btnGenerate"), dropZone: $("dropZone"), fileInput: $("fileInput"),
    recentSection: $("recentSection"), recentGrid: $("recentGrid"),
    // library
    libSubtitle: $("libSubtitle"), libEmpty: $("libEmpty"),
    libraryGrid: $("libraryGrid"), btnLibCreate: $("btnLibCreate"),
    // lesson
    btnBack: $("btnBack"), lessonTitle: $("lessonTitle"), lessonDate: $("lessonDate"),
    audioBar: $("audioBar"), audioPlay: $("audioPlay"), audioFill: $("audioFill"),
    audioLabel: $("audioLabel"), audioEl: $("audioEl"), tabPanel: $("tabPanel"),
    // footer
    footerStatus: $("footerStatus"),
  };

  /* ══ 2. State ═════════════════════════════════════════════ */
  let view    = "home";
  let current = null;  // active lesson object
  let activeTab = "conversation";

  /* ══ 3. Progress bar ═══════════════════════════════════════ */
  let _progTimer;
  const startProgress = () => {
    let v = 0;
    EL.navProgress.classList.add("show");
    EL.navProgressFill.style.width = "0%";
    clearInterval(_progTimer);
    _progTimer = setInterval(() => {
      v = Math.min(v + 5, 88);
      EL.navProgressFill.style.width = `${v}%`;
    }, 500);
  };
  const endProgress = () => {
    clearInterval(_progTimer);
    EL.navProgressFill.style.width = "100%";
    setTimeout(() => { EL.navProgress.classList.remove("show"); EL.navProgressFill.style.width = "0%"; }, 600);
  };

  /* ══ 4. Toast ══════════════════════════════════════════════ */
  let _toastTimer;
  const toast = (msg, ms = 6000) => {
    EL.toastText.textContent = msg;
    EL.toast.hidden = false;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => EL.toast.hidden = true, ms);
  };

  /* ══ 5. View router ════════════════════════════════════════ */
  const showView = (name) => {
    view = name;
    EL.viewHome.hidden    = name !== "home";
    EL.viewLibrary.hidden = name !== "library";
    EL.viewLesson.hidden  = name !== "lesson";
    EL.btnNavHome.classList.toggle("active",    name === "home");
    EL.btnNavLibrary.classList.toggle("active", name === "library");
    if (name === "library") renderLibrary();
    if (name === "home")    renderRecent();
  };

  /* ══ 6. Lesson card HTML ═══════════════════════════════════ */
  const cardHTML = (lesson) => {
    const tq = Object.values(lesson.questions || {}).flat().length;
    return `
      <div class="lesson-card" data-id="${lesson.localId}">
        <button class="lesson-card__del" data-del="${lesson.localId}" aria-label="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
        <div class="lesson-card__emoji">📚</div>
        <h3 class="lesson-card__title">${esc(lesson.topic)}</h3>
        <p class="lesson-card__desc">${esc(lesson.simple_explanation || "")}</p>
        <div class="lesson-card__badges">
          <span class="badge badge-teal">${lesson.conversation?.length || 0} exchanges</span>
          <span class="badge badge-gold">${tq} questions</span>
          <span class="badge badge-accent">${lesson.visual_suggestions?.length || 0} visuals</span>
          ${lesson.audioUrl ? '<span class="badge badge-teal">🔊 Audio</span>' : ""}
          ${lesson.synced   ? '<span class="badge badge-accent">☁ Saved</span>' : ""}
        </div>
        <p class="lesson-card__date">${new Date(lesson.createdAt).toLocaleDateString()}</p>
      </div>`;
  };

  const attachCardEvents = (container) => {
    container.querySelectorAll(".lesson-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) return;
        const id = card.dataset.id;
        const l  = DB.load(id);
        if (l) openLesson(l);
      });
    });
    container.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        DB.remove(btn.dataset.del);
        refreshNav();
        renderRecent();
        if (view === "library") renderLibrary();
        if (view === "lesson" && current?.localId === btn.dataset.del) showView("home");
      });
    });
  };

  /* ══ 7. Render helpers ═════════════════════════════════════ */
  const renderRecent = () => {
    refreshNav();
    const ls = DB.list().slice(0, 3);
    EL.recentSection.hidden = ls.length === 0;
    EL.recentGrid.innerHTML = ls.map(cardHTML).join("");
    attachCardEvents(EL.recentGrid);
  };

  const renderLibrary = () => {
    const ls = DB.list();
    EL.libSubtitle.textContent = `${ls.length} lesson${ls.length !== 1 ? "s" : ""} saved`;
    EL.libEmpty.hidden         = ls.length > 0;
    EL.libraryGrid.innerHTML   = ls.map(cardHTML).join("");
    attachCardEvents(EL.libraryGrid);
  };

  const refreshNav = () => {
    const n = DB.count();
    EL.navCount.textContent      = n;
    EL.btnNavLibrary.style.display = n > 0 ? "" : "none";
  };

  /* ══ 8. Open lesson ════════════════════════════════════════ */
  const openLesson = (lesson) => {
    current   = lesson;
    activeTab = "conversation";
    EL.lessonTitle.textContent = lesson.topic || "Lesson";
    EL.lessonDate.textContent  = new Date(lesson.createdAt)
      .toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

    // Audio bar
    if (lesson.audioUrl) {
      EL.audioBar.hidden     = false;
      EL.audioEl.src         = lesson.audioUrl;
      EL.audioLabel.textContent = "Podcast audio ready";
    } else {
      EL.audioBar.hidden = true;
    }

    document.querySelectorAll(".tab-pill").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === "conversation");
    });
    renderTab("conversation");
    showView("lesson");
  };

  /* ══ 9. Tab rendering ══════════════════════════════════════ */
  const renderTab = (tab) => {
    activeTab = tab;
    if (!current) return;
    const renderers = {
      conversation: renderConversation,
      quiz:         renderQuiz,
      summary:      renderSummary,
      visual:       renderVisual,
    };
    EL.tabPanel.innerHTML = "";
    renderers[tab]?.(current);
  };

  /* ─ Conversation ─ */
  const renderConversation = (l) => {
    const rows = (l.conversation || []).map((line, i) => {
      const isProf = line.speaker === "Professor";
      return `
        <div class="bubble-row ${isProf ? "" : "student"}">
          <div class="bubble-avatar ${isProf ? "prof" : "stud"}">${isProf ? "👨‍🏫" : "👩‍🎓"}</div>
          <div class="bubble-wrap">
            <div class="bubble-who">${esc(line.speaker)}</div>
            <div class="bubble ${isProf ? "prof-bubble" : "stud-bubble"}" data-idx="${i}">${esc(line.text)}</div>
          </div>
        </div>`;
    }).join("");

    EL.tabPanel.innerHTML = `
      <h2 class="tab-title">🎙️ Podcast Dialogue</h2>
      <p class="tab-sub">A ~2-minute conversation that explains the topic</p>
      <div class="conv-list">${rows}</div>`;

    EL.tabPanel.querySelectorAll(".bubble").forEach((b) => {
      b.addEventListener("click", () => b.classList.toggle("lit"));
    });
  };

  /* ─ Quiz ─ */
  const renderQuiz = (l) => {
    const LEVELS = [
      { key: "basic",    label: "Basic",    emoji: "🌱", color: "var(--teal)"   },
      { key: "medium",   label: "Medium",   emoji: "🔥", color: "var(--gold)"   },
      { key: "advanced", label: "Advanced", emoji: "⚡", color: "var(--danger)" },
    ];
    const totalQ = LEVELS.reduce((s, lv) => s + (l.questions[lv.key]?.length || 0), 0);

    const levelsHTML = LEVELS.map(({ key, label, emoji, color }) => {
      const qs = l.questions[key] || [];
      const cards = qs.map((q, i) => `
        <div class="q-card" data-qid="${key}-${i}">
          <div class="q-card__body">
            <div class="q-card__text">
              <span class="q-card__num" style="color:${color}">Q${i+1}.</span>${esc(q.q)}
            </div>
            <button class="reveal-btn" style="color:${color};border-color:${color};background:${color}22"
              data-reveal="${key}-${i}">Reveal</button>
          </div>
          <div class="q-card__ans" data-ans="${key}-${i}" style="border-color:${color}33;background:${color}0d" hidden>
            <span class="ans-lbl" style="color:${color}">✓ Answer:</span>${esc(q.a)}
          </div>
        </div>`).join("");
      return `
        <div class="quiz-level">
          <div class="quiz-level__hd">
            <span>${emoji}</span>
            <span class="quiz-level__name" style="color:${color}">${label}</span>
            <span class="badge badge-teal">${qs.length} questions</span>
          </div>
          ${cards}
        </div>`;
    }).join("");

    EL.tabPanel.innerHTML = `
      <h2 class="tab-title">🧠 Quiz &amp; Practice</h2>
      <div class="quiz-prog">
        <div class="quiz-prog__track"><div class="quiz-prog__fill" id="qBar" style="width:0%"></div></div>
        <span class="quiz-prog__lbl" id="qLbl">0 / ${totalQ} revealed</span>
      </div>
      ${levelsHTML}`;

    let revealed = 0;
    EL.tabPanel.querySelectorAll(".reveal-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id  = btn.dataset.reveal;
        const ans = EL.tabPanel.querySelector(`[data-ans="${id}"]`);
        if (ans?.hidden) {
          ans.hidden = false;
          btn.remove();
          revealed++;
          const pct = Math.round((revealed / totalQ) * 100);
          document.getElementById("qBar").style.width = `${pct}%`;
          document.getElementById("qLbl").textContent = `${revealed} / ${totalQ} revealed`;
        }
      });
    });
  };

  /* ─ Summary ─ */
  const renderSummary = (l) => {
    const pts = (l.summary || []).map((p, i) => `
      <div class="key-pt">
        <div class="key-pt__num">${i+1}</div>
        <div class="key-pt__text">${esc(p)}</div>
      </div>`).join("");
    EL.tabPanel.innerHTML = `
      <h2 class="tab-title">📋 Quick Summary</h2>
      <div class="expl-box">
        <div class="expl-box__lbl">💡 Simple Explanation</div>
        <div class="expl-box__text">${esc(l.simple_explanation || "")}</div>
      </div>
      <h3 style="color:var(--text);font-size:15px;font-weight:700;margin-bottom:14px">🔑 Key Points</h3>
      <div class="key-pts">${pts}</div>`;
  };

  /* ─ Visual Map ─ */
  const renderVisual = (l) => {
    const typeEmoji = { diagram: "📊", chart: "📈", illustration: "🖼️" };
    const visuals = (l.visual_suggestions || []).map((v) => `
      <div class="vis-item">
        <div class="vis-item__icon">${typeEmoji[v.type] || "🖼️"}</div>
        <div>
          <div class="vis-item__badges">
            <span class="badge badge-gold">${esc(v.timestamp)}</span>
            <span class="badge badge-accent">${esc(v.type)}</span>
          </div>
          <div class="vis-item__desc">${esc(v.description)}</div>
        </div>
      </div>`).join("");

    const script = l.audio_script || {};
    const colHTML = (role, color) => `
      <div>
        <div class="audio-col__lbl" style="color:${color}">${role} lines</div>
        ${(script[role] || []).slice(0, 4).map((line) =>
          `<div class="audio-line">"${esc(line)}"</div>`).join("")}
      </div>`;

    // TTS button
    const ttsBtn = l.audioUrl
      ? `<p style="color:var(--teal);font-size:13px;margin-top:16px">🔊 Audio already generated — use the player above.</p>`
      : `<button class="btn-primary" id="btnTTS" style="margin-top:16px">
           🔊 Generate Spoken Audio (ElevenLabs)
         </button>`;

    EL.tabPanel.innerHTML = `
      <h2 class="tab-title">🗺️ Visual Learning Map</h2>
      <p class="tab-sub">Suggested visuals &amp; TTS-ready audio script</p>
      <div class="vis-list">${visuals}</div>
      ${ttsBtn}
      <div class="audio-script" style="margin-top:28px">
        ${colHTML("professor", "var(--accent)")}
        ${colHTML("student",   "var(--teal)")}
      </div>`;

    document.getElementById("btnTTS")?.addEventListener("click", handleTTS);
  };

  /* ══ 10. Generate flow ═════════════════════════════════════ */
  const handleGenerate = async (text) => {
    if (!text?.trim()) return;
    startProgress();
    EL.btnGenerate.disabled     = true;
    EL.btnGenerate.innerHTML    = `<span class="spin"></span> Processing…`;

    try {
      const lesson = await API.generateLesson(text, (pct) => {
        EL.navProgressFill.style.width = `${pct}%`;
      });
      lesson.localId   = `lesson_${Date.now()}`;
      lesson.createdAt = Date.now();
      lesson.audioUrl  = null;
      lesson.synced    = false;

      await DB.save(lesson);
      refreshNav();
      openLesson(lesson);
    } catch (err) {
      toast("⚠️ " + (err.message || "Failed to generate lesson."));
    } finally {
      endProgress();
      EL.btnGenerate.disabled  = !EL.inputText.value.trim();
      EL.btnGenerate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate Lesson`;
    }
  };

/* ══ 11. TTS flow ══════════════════════════════════════════ */
const handleTTS = async () => {
  if (!current) return;

  const btn = document.getElementById("btnTTS");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Generating audio…";
  }

  try {
    // 🔥 UPDATED: dual voice call
    const url = await API.generateDualAudio(current.conversation);

    DB.patch(current.localId, { audioUrl: url });
    current.audioUrl = url;

    EL.audioBar.hidden = false;
    EL.audioEl.src = url;

    EL.audioLabel.textContent = "Podcast audio ready";

    renderTab("visual");

  } catch (err) {
    console.error("TTS ERROR:", err);
    toast("🔊 TTS error: " + err.message);

    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔊 Generate Spoken Audio (ElevenLabs)";
    }
  }
};

  /* ══ 12. Audio player ══════════════════════════════════════ */
  let audioPlaying = false;
  EL.audioPlay.addEventListener("click", () => {
    if (audioPlaying) {
      EL.audioEl.pause();
      EL.audioPlay.textContent = "▶";
      audioPlaying = false;
    } else {
      EL.audioEl.play();
      EL.audioPlay.textContent = "⏸";
      audioPlaying = true;
    }
  });
  EL.audioEl.addEventListener("timeupdate", () => {
    if (!EL.audioEl.duration) return;
    EL.audioFill.style.width = `${(EL.audioEl.currentTime / EL.audioEl.duration) * 100}%`;
  });
  EL.audioEl.addEventListener("ended", () => {
    EL.audioPlay.textContent = "▶";
    audioPlaying = false;
    EL.audioFill.style.width = "0%";
  });

  /* ══ 13. Event listeners ═══════════════════════════════════ */

  // Navbar
  EL.btnLogo.addEventListener("click",       () => showView("home"));
  EL.btnNavHome.addEventListener("click",    () => showView("home"));
  EL.btnNavLibrary.addEventListener("click", () => showView("library"));
  EL.btnLibCreate.addEventListener("click",  () => showView("home"));
  EL.btnBack.addEventListener("click",       () => showView(DB.count() > 1 ? "library" : "home"));

  // Toast
  EL.toastClose.addEventListener("click", () => EL.toast.hidden = true);

  // Mode toggle
  [EL.modePaste, EL.modeFile].forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      EL.modePaste.classList.toggle("active", mode === "paste");
      EL.modeFile.classList.toggle("active",  mode === "file");
      EL.panelPaste.hidden = mode !== "paste";
      EL.panelFile.hidden  = mode !== "file";
    });
  });

  // Textarea
  EL.inputText.addEventListener("input", () => {
    const n = EL.inputText.value.length;
    EL.charCount.textContent  = `${n} / 8000`;
    EL.btnGenerate.disabled   = n === 0;
  });
  EL.btnGenerate.addEventListener("click", () => handleGenerate(EL.inputText.value));

  // Drop zone
  EL.dropZone.addEventListener("click",   () => EL.fileInput.click());
  EL.dropZone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") EL.fileInput.click(); });
  EL.dropZone.addEventListener("dragover", (e) => { e.preventDefault(); EL.panelFile.classList.add("drag"); });
  EL.dropZone.addEventListener("dragleave", () => EL.panelFile.classList.remove("drag"));
  EL.dropZone.addEventListener("drop", async (e) => {
    e.preventDefault(); EL.panelFile.classList.remove("drag");
    const file = e.dataTransfer.files?.[0];
    if (file) await handleFile(file);
  });
  EL.fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (file) await handleFile(file);
    EL.fileInput.value = "";
  });

  const handleFile = async (file) => {
    let text = "";
    try {
      text = file.type === "text/plain" ? await API.readText(file) : await API.readPDF(file);
    } catch (err) { toast("⚠️ " + err.message); return; }
    if (!text.trim()) { toast("⚠️ No text found. Try pasting instead."); return; }
    await handleGenerate(text);
  };

  // Tabs
  document.querySelectorAll(".tab-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderTab(btn.dataset.tab);
    });
  });

  /* ══ 14. Utilities ═════════════════════════════════════════ */
  const esc = (s) => String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");

  /* ══ 15. Boot ══════════════════════════════════════════════ */
  const boot = async () => {
    renderRecent();
    showView("home");

    // Check server health
    const ok = await API.health();
    EL.footerStatus.textContent = ok ? "●  Server online" : "●  Server offline";
    EL.footerStatus.style.color = ok ? "var(--teal)" : "var(--danger)";

    // Pull any lessons from MongoDB
    if (ok) DB.syncFromMongo().then(renderRecent).catch(() => {});
  };

  boot();

})();