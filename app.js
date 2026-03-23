/**
 * app.js — EduAI v2  Application Logic
 */

(() => {
  "use strict";

  /* ══ 1. DOM refs ══════════════════════════════════════════ */
  const $ = (id) => document.getElementById(id);

  const EL = {
    viewHome: $("viewHome"), viewLibrary: $("viewLibrary"), viewLesson: $("viewLesson"),
    btnLogo: $("btnLogo"), btnNavHome: $("btnNavHome"), btnNavLibrary: $("btnNavLibrary"),
    navCount: $("navCount"), navProgress: $("navProgress"), navProgressFill: $("navProgressFill"),
    toast: $("toast"), toastText: $("toastText"), toastClose: $("toastClose"),
    modePaste: $("modePaste"), modeFile: $("modeFile"),
    panelPaste: $("panelPaste"), panelFile: $("panelFile"),
    inputText: $("inputText"), charCount: $("charCount"),
    btnGenerate: $("btnGenerate"), dropZone: $("dropZone"), fileInput: $("fileInput"),
    recentSection: $("recentSection"), recentGrid: $("recentGrid"),
    libSubtitle: $("libSubtitle"), libEmpty: $("libEmpty"),
    libraryGrid: $("libraryGrid"), btnLibCreate: $("btnLibCreate"),
    btnBack: $("btnBack"), lessonTitle: $("lessonTitle"), lessonDate: $("lessonDate"),
    audioBar: $("audioBar"), audioPlay: $("audioPlay"), audioFill: $("audioFill"),
    audioLabel: $("audioLabel"), audioEl: $("audioEl"), tabPanel: $("tabPanel"),
    footerStatus: $("footerStatus"),
  };

  /* ══ 2. State ═════════════════════════════════════════════ */
  let view         = "home";
  let current      = null;
  let activeTab    = "conversation";
  let learningMode = "student";
  let _qaHistory   = [];
  let audioPlaying = false;

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
    setTimeout(() => {
      EL.navProgress.classList.remove("show");
      EL.navProgressFill.style.width = "0%";
    }, 600);
  };

  /* ══ 4. Toast ══════════════════════════════════════════════ */
  let _toastTimer;
  const toast = (msg, type = "error", ms = 5000) => {
    if (!msg || !msg.trim()) return;
    EL.toastText.textContent = msg;
    EL.toast.hidden = false;
    EL.toast.className = "toast toast--" + type;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      EL.toast.classList.add("toast--hiding");
      setTimeout(() => {
        EL.toast.hidden = true;
        EL.toast.classList.remove("toast--hiding");
      }, 300);
    }, ms);
  };
  const toastInfo  = (msg) => toast(msg, "info",    5000);
  const toastError = (msg) => toast(msg, "error",   6000);
  const toastWarn  = (msg) => toast(msg, "warning", 5000);

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
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
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
        const l = DB.load(card.dataset.id);
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
    EL.navCount.textContent        = n;
    EL.btnNavLibrary.style.display = n > 0 ? "" : "none";
  };

  /* ══ 8. Open lesson ════════════════════════════════════════ */
  const MODE_META = {
    student: { label: "🎒 Student", cls: "mode-student" },
    kids:    { label: "🧸 Kids",    cls: "mode-kids"    },
    exam:    { label: "📝 Exam",    cls: "mode-exam"    },
  };

  const openLesson = (lesson) => {
    current    = lesson;
    activeTab  = "conversation";
    _qaHistory = [];

    EL.lessonTitle.textContent = lesson.topic || "Lesson";
    EL.lessonDate.textContent  = new Date(lesson.createdAt)
      .toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

    const modeBadge = $("lessonModeBadge");
    if (modeBadge) {
      const m    = lesson.learningMode || "student";
      const meta = MODE_META[m] || MODE_META.student;
      modeBadge.textContent   = meta.label;
      modeBadge.className     = `lesson-mode-badge ${meta.cls}`;
      modeBadge.style.display = "";
    }

    if (lesson.audioUrl) {
      EL.audioBar.hidden        = false;
      EL.audioEl.src            = lesson.audioUrl;
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
      cheatsheet:   renderCheatSheet,
      summary:      renderSummary,
      visual:       renderVisual,
    };
    EL.tabPanel.innerHTML = "";
    renderers[tab]?.(current);
  };

  /* ══ Utility: build full interleaved audio script ══════════ */
  const buildFullScript = (lesson) => {
    const conv = lesson?.conversation || [];
    if (conv.length > 0) {
      return conv.map(l => `${l.speaker}: ${l.text}`).join("  ");
    }
    const profLines = lesson?.audio_script?.professor || [];
    const studLines = lesson?.audio_script?.student   || [];
    const maxLen    = Math.max(profLines.length, studLines.length);
    const lines     = [];
    for (let i = 0; i < maxLen; i++) {
      if (studLines[i]) lines.push(`Student: ${studLines[i]}`);
      if (profLines[i]) lines.push(`Professor: ${profLines[i]}`);
    }
    return lines.join("  ");
  };

  /* ══ Utility: format answer text — renders code blocks ════ */
  const formatAnswer = (text) => {
    if (!text) return "";
    const codeKeywords = /\b(class|public|private|void|int|String|double|float|boolean|char|long|byte|short|static|new |return |import |package |System\.out|if\s*\(|for\s*\(|while\s*\(|extends|implements|interface|enum|try\s*\{|catch\s*\(|throws)\b/;
    const hasCode = codeKeywords.test(text);
    if (!hasCode) return esc(text).replace(/\n/g, "<br>");
    const lines     = text.split("\n");
    const firstCode = lines.findIndex(l => codeKeywords.test(l));
    if (firstCode === -1) return esc(text).replace(/\n/g, "<br>");
    const prosePart = lines.slice(0, firstCode).join("\n").trim();
    const codePart  = lines.slice(firstCode).join("\n").trim();
    const proseHTML = prosePart ? `<span>${esc(prosePart)}</span><br><br>` : "";
    return `${proseHTML}<code class="qa-code">${esc(codePart)}</code>`;
  };

  /* ─ Conversation + Q&A ─ */
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

    const qaHistoryHTML = _qaHistory.map(msg => `
      <div class="qa-msg ${msg.role}">
        <div class="qa-avatar ${msg.role === "user" ? "user-av" : "prof"}">
          ${msg.role === "user" ? "👤" : "👨‍🏫"}
        </div>
        <div class="qa-bubble ${msg.role === "user" ? "user" : "prof"} ${msg.loading ? "loading" : ""}">
          ${msg.loading ? esc(msg.text) : formatAnswer(msg.text)}
        </div>
      </div>`).join("");

    EL.tabPanel.innerHTML = `
      <h2 class="tab-title">🎙️ Podcast Dialogue</h2>
      <p class="tab-sub">A ~2-minute conversation that explains the topic</p>
      <div class="conv-list">${rows}</div>
      <div class="qa-box">
        <h3 class="qa-box__title">💬 Ask a Question</h3>
        <p class="qa-box__sub">Ask anything about this topic — the professor will answer based on the lesson content.</p>
        <div class="qa-history" id="qaHistory">${qaHistoryHTML}</div>
        <div class="qa-input-row">
          <textarea class="qa-input" id="qaInput" rows="1"
            placeholder="e.g. Can you explain immutability with another example?"></textarea>
          <button class="qa-send-btn" id="qaSend" title="Send question">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>`;

    EL.tabPanel.querySelectorAll(".bubble").forEach((b) => {
      b.addEventListener("click", () => b.classList.toggle("lit"));
    });
    const qaInput = $("qaInput");
    qaInput?.addEventListener("input", () => {
      qaInput.style.height = "auto";
      qaInput.style.height = Math.min(qaInput.scrollHeight, 120) + "px";
    });
    qaInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQA(); }
    });
    $("qaSend")?.addEventListener("click", sendQA);
    const hist = $("qaHistory");
    if (hist) hist.scrollTop = hist.scrollHeight;
  };

  const sendQA = async () => {
    const input   = $("qaInput");
    const sendBtn = $("qaSend");
    const q = input?.value.trim();
    if (!q || !current) return;
    _qaHistory.push({ role: "user", text: q });
    input.value = ""; input.style.height = "auto";
    if (sendBtn) sendBtn.disabled = true;
    _qaHistory.push({ role: "prof", text: "Thinking…", loading: true });
    renderConversation(current);
    try {
      const ctx = [
        current.sourceText ? `Original content:\n${current.sourceText.slice(0, 2000)}` : "",
        `Conversation:\n${(current.conversation || []).map(l => `${l.speaker}: ${l.text}`).join("\n").slice(0, 800)}`,
      ].filter(Boolean).join("\n\n");
      const answer = await API.askQuestion(q, current.topic, ctx);
      _qaHistory[_qaHistory.length - 1] = { role: "prof", text: answer };
    } catch {
      _qaHistory[_qaHistory.length - 1] = { role: "prof", text: "Connection error. Please try again." };
    }
    renderConversation(current);
  };

  /* ══════════════════════════════════════════════════════════
     ─ Quiz — MCQ with navigation, scoring, explanations ─
  ══════════════════════════════════════════════════════════ */
  const renderQuiz = (l) => {
    // Flatten all questions from all levels into one array with level info
    const LEVELS = [
      { key: "basic",    label: "Basic",    emoji: "🌱", color: "var(--teal)"   },
      { key: "medium",   label: "Medium",   emoji: "🔥", color: "var(--gold)"   },
      { key: "advanced", label: "Advanced", emoji: "⚡", color: "var(--danger)" },
    ];

    // Build flat question list
    const allQuestions = [];
    LEVELS.forEach(({ key, label, emoji, color }) => {
      (l.questions[key] || []).forEach((q) => {
        allQuestions.push({ ...q, level: label, emoji, color });
      });
    });

    if (allQuestions.length === 0) {
      EL.tabPanel.innerHTML = `<p style="color:var(--muted)">No questions available.</p>`;
      return;
    }

    // State
    let currentQ  = 0;
    let answers   = new Array(allQuestions.length).fill(null); // selected option letter
    let submitted = false;

    const renderQuestion = () => {
      const q       = allQuestions[currentQ];
      const total   = allQuestions.length;
      const pct     = Math.round(((currentQ) / total) * 100);
      const ans     = answers[currentQ];
      const isLast  = currentQ === total - 1;

      // Check if old format (no options) — fallback to reveal style
      const hasOptions = q.options && q.options.length === 4;

      const optionsHTML = hasOptions
        ? q.options.map((opt, i) => {
            const letter = ["A","B","C","D"][i];
            const sel    = ans === letter;
            return `
              <button class="quiz-opt ${sel ? "selected" : ""}"
                data-letter="${letter}" ${submitted ? "disabled" : ""}>
                <span class="quiz-opt__letter">${letter}</span>
                <span class="quiz-opt__text">${esc(opt.replace(/^[A-D]\.\s*/,""))}</span>
              </button>`;
          }).join("")
        : `<div class="quiz-opt-legacy">
             <button class="reveal-btn" style="color:var(--accent);border-color:var(--accent);background:var(--accent)22"
               id="legacyReveal">Show Answer</button>
             <div id="legacyAns" hidden style="margin-top:12px;color:var(--text);font-size:14px">
               <span style="color:var(--teal);font-weight:700">✓ Answer: </span>${esc(q.a || "")}
             </div>
           </div>`;

      EL.tabPanel.innerHTML = `
        <h2 class="tab-title">🧠 Quiz &amp; Practice</h2>

        <!-- Progress -->
        <div class="quiz-prog" style="margin-bottom:20px">
          <div class="quiz-prog__track">
            <div class="quiz-prog__fill" style="width:${pct}%"></div>
          </div>
          <span class="quiz-prog__lbl">Q${currentQ + 1} / ${total}</span>
        </div>

        <!-- Level badge -->
        <div style="margin-bottom:14px">
          <span class="badge badge-teal" style="color:${q.color};background:${q.color}22;border-color:${q.color}44">
            ${q.emoji} ${q.level}
          </span>
        </div>

        <!-- Question card -->
        <div class="q-mcq-card">
          <div class="q-mcq-num">Question ${currentQ + 1}</div>
          <div class="q-mcq-text">${esc(q.q)}</div>

          <!-- Options -->
          <div class="q-mcq-options" id="quizOptions">
            ${optionsHTML}
          </div>
        </div>

        <!-- Navigation -->
        <div class="quiz-nav">
          <button class="quiz-nav-btn" id="btnPrev" ${currentQ === 0 ? "disabled" : ""}>
            ← Previous
          </button>
          <div class="quiz-dots">
            ${allQuestions.map((_, i) => `
              <div class="quiz-dot ${i === currentQ ? "active" : ""} ${answers[i] !== null ? "answered" : ""}"></div>
            `).join("")}
          </div>
          ${isLast
            ? `<button class="quiz-nav-btn quiz-nav-btn--submit" id="btnSubmit"
                 ${answers.some(a => a !== null) ? "" : "disabled"}>
                 Submit Quiz ✓
               </button>`
            : `<button class="quiz-nav-btn quiz-nav-btn--next" id="btnNext">
                 Next →
               </button>`
          }
        </div>`;

      // Option click
      if (hasOptions && !submitted) {
        document.querySelectorAll(".quiz-opt").forEach((btn) => {
          btn.addEventListener("click", () => {
            answers[currentQ] = btn.dataset.letter;
            renderQuestion();
          });
        });
      }

      // Legacy reveal
      $("legacyReveal")?.addEventListener("click", () => {
        $("legacyAns").hidden = false;
        $("legacyReveal").style.display = "none";
      });

      // Prev / Next
      $("btnPrev")?.addEventListener("click", () => { currentQ--; renderQuestion(); });
      $("btnNext")?.addEventListener("click", () => { currentQ++; renderQuestion(); });

      // Submit
      $("btnSubmit")?.addEventListener("click", () => {
        submitted = true;
        renderResults();
      });
    };

    const renderResults = () => {
      const total   = allQuestions.length;
      const correct = allQuestions.filter((q, i) => answers[i] === q.answer).length;
      const pct     = Math.round((correct / total) * 100);

      const scoreColor = pct >= 80 ? "var(--teal)"
                       : pct >= 50 ? "var(--gold)"
                       : "var(--danger)";

      const scoreEmoji = pct >= 80 ? "🎉" : pct >= 50 ? "👍" : "📖";
      const scoreMsg   = pct >= 80 ? "Excellent work!"
                       : pct >= 50 ? "Good effort — review the missed ones!"
                       : "Keep studying — you've got this!";

      const reviewHTML = allQuestions.map((q, i) => {
        const userAns    = answers[i];
        const isCorrect  = userAns === q.answer;
        const hasOptions = q.options && q.options.length === 4;

        const optionsHTML = hasOptions
          ? q.options.map((opt, oi) => {
              const letter = ["A","B","C","D"][oi];
              let cls = "quiz-opt quiz-opt--review";
              if (letter === q.answer)            cls += " correct";
              else if (letter === userAns && !isCorrect) cls += " wrong";
              return `
                <div class="${cls}">
                  <span class="quiz-opt__letter">${letter}</span>
                  <span class="quiz-opt__text">${esc(opt.replace(/^[A-D]\.\s*/,""))}</span>
                  ${letter === q.answer     ? '<span class="quiz-opt__tag">✓ Correct</span>'  : ""}
                  ${letter === userAns && !isCorrect ? '<span class="quiz-opt__tag wrong-tag">✗ Your answer</span>' : ""}
                </div>`;
            }).join("")
          : `<div style="color:var(--teal);font-size:14px">Answer: ${esc(q.a || "")}</div>`;

        return `
          <div class="quiz-review-item ${isCorrect ? "review-correct" : "review-wrong"}">
            <div class="quiz-review-header">
              <span class="quiz-review-icon">${isCorrect ? "✅" : "❌"}</span>
              <span class="quiz-review-q">Q${i + 1}: ${esc(q.q)}</span>
            </div>
            <div class="quiz-review-opts">${optionsHTML}</div>
            ${q.explanation ? `
              <div class="quiz-review-explanation">
                <span class="quiz-review-explanation__label">💡 Explanation:</span>
                ${esc(q.explanation)}
              </div>` : ""}
          </div>`;
      }).join("");

      EL.tabPanel.innerHTML = `
        <h2 class="tab-title">🧠 Quiz Results</h2>

        <!-- Score card -->
        <div class="quiz-score-card" style="border-color:${scoreColor}44">
          <div class="quiz-score-emoji">${scoreEmoji}</div>
          <div class="quiz-score-num" style="color:${scoreColor}">${correct} / ${total}</div>
          <div class="quiz-score-pct" style="color:${scoreColor}">${pct}%</div>
          <div class="quiz-score-msg">${scoreMsg}</div>
          <div class="quiz-score-bar">
            <div class="quiz-score-bar__fill" style="width:${pct}%;background:${scoreColor}"></div>
          </div>
        </div>

        <!-- Retake button -->
        <div style="text-align:center;margin:20px 0">
          <button class="btn-primary" id="btnRetake">🔄 Retake Quiz</button>
        </div>

        <!-- Review all questions -->
        <h3 class="quiz-review-title">📋 Question Review</h3>
        <div class="quiz-review-list">${reviewHTML}</div>`;

      $("btnRetake")?.addEventListener("click", () => {
        answers   = new Array(allQuestions.length).fill(null);
        submitted = false;
        currentQ  = 0;
        renderQuestion();
      });
    };

    renderQuestion();
  };

  /* ══════════════════════════════════════════════════════════
     ─ Summary — detailed with overview, notes, conclusion ─
  ══════════════════════════════════════════════════════════ */
  const renderSummary = (l) => {
    const s = l.summary || {};

    // Handle both old (array) and new (object) formats
    if (Array.isArray(s)) {
      const pts = s.map((p, i) => `
        <div class="key-pt">
          <div class="key-pt__num">${i + 1}</div>
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
      return;
    }

    // New detailed format
    const overviewHTML = s.overview
      ? `<div class="summary-overview">
           <div class="summary-section-label">📖 Overview</div>
           <p class="summary-overview-text">${esc(s.overview)}</p>
         </div>` : "";

    const keyPtsHTML = (s.key_points || []).map((p, i) => `
      <div class="key-pt">
        <div class="key-pt__num">${i + 1}</div>
        <div class="key-pt__text">${esc(p)}</div>
      </div>`).join("");

    const detailedHTML = (s.detailed_notes || []).map((note) => `
      <div class="summary-note-card">
        <div class="summary-note-heading">${esc(note.heading)}</div>
        <div class="summary-note-content">${esc(note.content)}</div>
      </div>`).join("");

    const conclusionHTML = s.conclusion
      ? `<div class="summary-conclusion">
           <div class="summary-section-label">🎯 Conclusion</div>
           <p class="summary-conclusion-text">${esc(s.conclusion)}</p>
         </div>` : "";

    EL.tabPanel.innerHTML = `
      <h2 class="tab-title">📋 Detailed Summary</h2>

      <!-- Simple explanation -->
      <div class="expl-box" style="margin-bottom:24px">
        <div class="expl-box__lbl">💡 Simple Explanation</div>
        <div class="expl-box__text">${esc(l.simple_explanation || "")}</div>
      </div>

      <!-- Overview -->
      ${overviewHTML}

      <!-- Key points -->
      <div class="summary-section-label" style="margin-top:24px">🔑 Key Points</div>
      <div class="key-pts" style="margin-top:12px">${keyPtsHTML}</div>

      <!-- Detailed notes -->
      ${detailedHTML ? `
        <div class="summary-section-label" style="margin-top:28px">📝 Detailed Notes</div>
        <div class="summary-notes-grid" style="margin-top:12px">${detailedHTML}</div>
      ` : ""}

      <!-- Conclusion -->
      ${conclusionHTML}`;
  };

  /* ─ Cheat Sheet ─ */
  const renderCheatSheet = (l) => {
    const cs = l.cheatsheet || {};
    const keyTermsHTML = (cs.key_terms || []).map((t) => `
      <div class="cs-row">
        <div class="cs-row__q">${esc(t.term)}</div>
        <div class="cs-row__a">${esc(t.definition)}</div>
      </div>`).join("") || '<p style="color:var(--muted);font-size:13px">No key terms found.</p>';
    const conceptsHTML = (cs.core_concepts || []).map((c) =>
      `<div class="cs-bullet">${esc(c)}</div>`).join("");
    const quickQAHTML = (cs.quick_qa || []).map((q) => `
      <div class="cs-row">
        <div class="cs-row__q">${esc(q.q)}</div>
        <div class="cs-row__a">${esc(q.a)}</div>
      </div>`).join("");
    const formulasHTML = (cs.formulas || []).length
      ? `<div class="cs-section">
           <div class="cs-section__title">⚗️ Formulas &amp; Rules</div>
           <div class="cs-formula-grid">
             ${(cs.formulas || []).map((f) => `
               <div class="cs-formula">
                 <div class="cs-formula__label">${esc(f.label)}</div>
                 <div class="cs-formula__value">${esc(f.value)}</div>
               </div>`).join("")}
           </div>
         </div>` : "";
    const tipsHTML = (cs.memory_tips || []).map((t) =>
      `<span class="cs-pill teal">${esc(t)}</span>`).join("");
    const modeColors = { student: "var(--accent)", kids: "var(--teal)", exam: "var(--gold)" };
    const modeColor  = modeColors[l.learningMode || "student"];
    const modeLabel  = { student: "Student", kids: "Kids 🧸", exam: "Exam 📝" }[l.learningMode || "student"];
    EL.tabPanel.innerHTML = `
      <div class="cheatsheet">
        <div class="cheatsheet__header" style="background:color-mix(in srgb,${modeColor} 8%,var(--card))">
          <div class="cheatsheet__header-left">
            <span class="cheatsheet__icon">📄</span>
            <div>
              <div class="cheatsheet__title">Cheat Sheet</div>
              <div class="cheatsheet__topic">${esc(l.topic)} · ${modeLabel} Mode</div>
            </div>
          </div>
          <button class="cheatsheet__download" onclick="window.print()">🖨️ Print / Save PDF</button>
        </div>
        <div class="cheatsheet__body">
          <div class="cs-section">
            <div class="cs-section__title">📖 Key Terms</div>
            <div class="cs-rows">${keyTermsHTML}</div>
          </div>
          <div class="cs-section">
            <div class="cs-section__title">💡 Core Concepts</div>
            <div class="cs-bullets">${conceptsHTML}</div>
          </div>
          <div class="cs-section">
            <div class="cs-section__title">❓ Quick Q&amp;A</div>
            <div class="cs-rows">${quickQAHTML}</div>
          </div>
          ${formulasHTML}
          ${tipsHTML ? `
          <div class="cs-section">
            <div class="cs-section__title">🧠 Memory Tips</div>
            <div class="cs-pills">${tipsHTML}</div>
          </div>` : ""}
        </div>
        <div class="cheatsheet__print-note">
          💡 Use Ctrl+P (or ⌘+P) and select "Save as PDF" to download this cheat sheet
        </div>
      </div>`;
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
    const script  = l.audio_script || {};
    const colHTML = (role, color) => `
      <div>
        <div class="audio-col__lbl" style="color:${color}">${role} lines</div>
        ${(script[role] || []).slice(0, 4).map((line) =>
          `<div class="audio-line">"${esc(line)}"</div>`).join("")}
      </div>`;
    const ttsBtn = l.audioUrl
      ? `<p style="color:var(--teal);font-size:13px;margin-top:16px">🔊 Audio already generated — use the player above.</p>`
      : `<button class="btn-primary" id="btnTTS" style="margin-top:16px">🔊 Generate Spoken Audio (ElevenLabs)</button>`;
    EL.tabPanel.innerHTML = `
      <h2 class="tab-title">🗺️ Visual Learning Map</h2>
      <p class="tab-sub">Suggested visuals &amp; TTS-ready audio script</p>
      <div class="vis-list">${visuals}</div>
      ${ttsBtn}
      <div class="audio-script" style="margin-top:28px">
        ${colHTML("professor", "var(--accent)")}
        ${colHTML("student",   "var(--teal)")}
      </div>`;
    $("btnTTS")?.addEventListener("click", handleTTS);
  };

  /* ══ 10. Generate flow ═════════════════════════════════════ */
  const handleGenerate = async (text) => {
    if (!text?.trim()) return;
    startProgress();
    EL.btnGenerate.disabled  = true;
    EL.btnGenerate.innerHTML = `<span class="spin"></span> Processing…`;
    try {
      const modeLabel = { student: "🎒 Student", kids: "🧸 Kids", exam: "📝 Exam" };
      EL.btnGenerate.innerHTML = `<span class="spin"></span> ${modeLabel[learningMode] || ""} Mode…`;
      const lesson = await API.generateLesson(text, (pct) => {
        EL.navProgressFill.style.width = `${pct}%`;
        if (pct === 55) EL.btnGenerate.innerHTML = `<span class="spin"></span> AI thinking…`;
      }, learningMode);
      lesson.localId      = `lesson_${Date.now()}`;
      lesson.createdAt    = Date.now();
      lesson.audioUrl     = null;
      lesson.synced       = false;
      lesson.learningMode = learningMode;
      lesson.sourceText   = text.trim().slice(0, 3000);
      await DB.save(lesson);
      refreshNav();
      openLesson(lesson);
    } catch (err) {
      const msg = err.message || "Failed to generate lesson.";
      if (msg.includes("503") || msg.includes("busy") || msg.includes("rate")) {
        toastWarn("⏳ AI is busy — retrying automatically. Please wait…");
      } else {
        toast("⚠️ " + msg);
      }
    } finally {
      endProgress();
      EL.btnGenerate.disabled  = !EL.inputText.value.trim();
      EL.btnGenerate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate Lesson`;
    }
  };

  /* ══ 11. TTS ═══════════════════════════════════════════════ */
  const speakWithBrowser = (text) => {
    if (!window.speechSynthesis) { toastError("⚠️ Your browser does not support speech synthesis."); return; }
    window.speechSynthesis.cancel();
    const hasSpeakers = /^(Student|Professor):/m.test(text);
    let chunks = [];
    if (hasSpeakers) {
      chunks = text.split(/(?=(?:Student|Professor):)/).map(s => s.trim()).filter(Boolean);
    } else {
      const CHUNK = 200;
      for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    }
    let idx = 0;
    const speakNext = () => {
      if (idx >= chunks.length) {
        EL.audioPlay.textContent = "▶"; EL.audioLabel.textContent = "Playback complete"; audioPlaying = false; return;
      }
      const chunk     = chunks[idx++];
      const isStud    = chunk.startsWith("Student:");
      const speakText = chunk.replace(/^(Student|Professor):\s*/, "").trim();
      if (!speakText) { speakNext(); return; }
      const utt      = new SpeechSynthesisUtterance(speakText);
      utt.rate       = 0.92;
      utt.onend      = speakNext;
      utt.onerror    = () => speakNext();
      const voices   = window.speechSynthesis.getVoices();
      const enVoices = voices.filter(v => v.lang.startsWith("en"));
      if (isStud) { utt.pitch = 1.25; utt.voice = enVoices[1] || enVoices[0] || voices[0]; }
      else        { utt.pitch = 0.9;  utt.voice = enVoices[0] || voices[0]; }
      window.speechSynthesis.speak(utt);
    };
    EL.audioBar.hidden = false;
    EL.audioLabel.textContent = "Speaking (browser voice)…";
    EL.audioPlay.textContent  = "⏸";
    audioPlaying = true;
    speakNext();
  };

  const handleTTS = async () => {
    if (!current) return;
    const btn = $("btnTTS");
    if (btn) { btn.disabled = true; btn.textContent = "Generating audio…"; }
    try {
      const scriptText = buildFullScript(current);
      const url        = await API.generateAudio(current.localId, scriptText);
      DB.patch(current.localId, { audioUrl: url });
      current.audioUrl = url;
      EL.audioBar.hidden = false; EL.audioEl.src = url;
      EL.audioLabel.textContent = "ElevenLabs audio ready ✨";
      EL.audioEl.play()
        .then(() => { EL.audioPlay.textContent = "⏸"; audioPlaying = true; })
        .catch(() => { EL.audioLabel.textContent = "Click ▶ to play ElevenLabs audio"; });
      renderTab("visual");
    } catch (err) {
      console.warn("ElevenLabs failed:", err.message);
      const scriptText = buildFullScript(current);
      if (scriptText && window.speechSynthesis) {
        toastInfo("🔊 Using browser voice — ElevenLabs key needs updating");
        speakWithBrowser(scriptText);
        if (btn) btn.textContent = "🔊 Playing (browser voice)";
      } else {
        toast("🔊 Audio unavailable: " + err.message);
        if (btn) { btn.disabled = false; btn.textContent = "🔊 Generate Spoken Audio (ElevenLabs)"; }
      }
    }
  };

  /* ══ 12. Audio player ══════════════════════════════════════ */
  EL.audioPlay.addEventListener("click", () => {
    if (current?.audioUrl && EL.audioEl.src) {
      if (audioPlaying) { EL.audioEl.pause(); EL.audioPlay.textContent = "▶"; audioPlaying = false; }
      else              { EL.audioEl.play();  EL.audioPlay.textContent = "⏸"; audioPlaying = true;  }
      return;
    }
    if (window.speechSynthesis) {
      if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        window.speechSynthesis.pause();  EL.audioPlay.textContent = "▶"; audioPlaying = false;
      } else if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume(); EL.audioPlay.textContent = "⏸"; audioPlaying = true;
      }
    }
  });
  EL.audioEl.addEventListener("timeupdate", () => {
    if (!EL.audioEl.duration) return;
    EL.audioFill.style.width = `${(EL.audioEl.currentTime / EL.audioEl.duration) * 100}%`;
  });
  EL.audioEl.addEventListener("ended", () => {
    EL.audioPlay.textContent = "▶"; audioPlaying = false; EL.audioFill.style.width = "0%";
  });

  /* ══ 13. Event listeners ═══════════════════════════════════ */
  document.querySelectorAll(".lmode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      learningMode = btn.dataset.mode;
      document.querySelectorAll(".lmode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  EL.btnLogo.addEventListener("click",       () => showView("home"));
  EL.btnNavHome.addEventListener("click",    () => showView("home"));
  EL.btnNavLibrary.addEventListener("click", () => showView("library"));
  EL.btnLibCreate.addEventListener("click",  () => showView("home"));
  EL.btnBack.addEventListener("click",       () => showView(DB.count() > 1 ? "library" : "home"));
  EL.toastClose.addEventListener("click", () => {
    clearTimeout(_toastTimer);
    EL.toast.hidden = true; EL.toast.className = "toast"; EL.toastText.textContent = "";
  });
  [EL.modePaste, EL.modeFile].forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      EL.modePaste.classList.toggle("active", mode === "paste");
      EL.modeFile.classList.toggle("active",  mode === "file");
      EL.panelPaste.hidden = mode !== "paste";
      EL.panelFile.hidden  = mode !== "file";
    });
  });
  EL.inputText.addEventListener("input", () => {
    const n = EL.inputText.value.length;
    EL.charCount.textContent = `${n} / 8000`;
    EL.btnGenerate.disabled  = n === 0;
  });
  EL.btnGenerate.addEventListener("click", () => handleGenerate(EL.inputText.value));
  EL.dropZone.addEventListener("click",     () => EL.fileInput.click());
  EL.dropZone.addEventListener("keydown",   (e) => { if (e.key === "Enter" || e.key === " ") EL.fileInput.click(); });
  EL.dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); EL.panelFile.classList.add("drag"); });
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
    if (!file) return;
    const name = file.name;
    EL.btnGenerate.innerHTML = `<span class="spin"></span> Reading ${name}…`;
    let text = "";
    try { text = await API.readFile(file); }
    catch (err) {
      toastError("⚠️ Could not read " + name + ": " + err.message);
      EL.btnGenerate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate Lesson`;
      return;
    }
    if (!text.trim()) { toastError("⚠️ No readable text found in " + name + ". Try pasting directly."); return; }
    await handleGenerate(text);
  };
  const btnRegenAudio = $("btnRegenAudio");
  if (btnRegenAudio) {
    btnRegenAudio.addEventListener("click", async () => {
      if (!current) return;
      btnRegenAudio.disabled = true; btnRegenAudio.textContent = "⏳";
      const scriptText = buildFullScript(current);
      try {
        const url = await API.generateAudio(current.localId, scriptText);
        DB.patch(current.localId, { audioUrl: url });
        current.audioUrl = url; EL.audioEl.src = url; EL.audioEl.play();
        EL.audioPlay.textContent = "⏸"; EL.audioLabel.textContent = "ElevenLabs audio ✨"; audioPlaying = true;
      } catch (err) {
        console.warn("ElevenLabs regen failed:", err.message);
        if (scriptText && window.speechSynthesis) {
          toastInfo("🔊 Using browser voice — ElevenLabs key needs updating");
          window.speechSynthesis.cancel();
          speakWithBrowser(scriptText);
        } else { toastError("🔊 Audio unavailable: " + err.message); }
      } finally { btnRegenAudio.disabled = false; btnRegenAudio.textContent = "🔄"; }
    });
  }
  document.querySelectorAll(".tab-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderTab(btn.dataset.tab);
    });
  });

  /* ══ 14. Utilities ═════════════════════════════════════════ */
  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* ══ 15. Boot ══════════════════════════════════════════════ */
  const boot = async () => {
    renderRecent();
    showView("home");
    const ok = await API.health();
    EL.footerStatus.textContent = ok ? "●  Server online" : "●  Server offline";
    EL.footerStatus.style.color = ok ? "var(--teal)"      : "var(--danger)";
    if (ok) DB.syncFromMongo().then(renderRecent).catch(() => {});
  };

  boot();

})();
