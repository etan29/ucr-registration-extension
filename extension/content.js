(() => {
  const LEGACY_HEADER_CLASS = "ucrd-data-col-header";
  const LEGACY_CELL_CLASS = "ucrd-data-cell";
  const DELIVERY_STACK_CLASS = "ucrd-delivery-stack";
  const DELIVERY_ENHANCED_CLASS = "ucrd-delivery-enhanced";

  /** Host page containers that wrap the class search results (Banner / SSb patterns). */
  const RESULTS_ROOT_SELECTORS = [
    "#searchResultsTable",
    "#classSearchResultsTable",
    '[id*="searchResults" i]',
    '[id*="SearchResults" i]',
    '[class*="search-results" i]',
    '[class*="searchResults" i]',
    ".dataTables_wrapper",
  ];

  let debounceTimer = null;
  let docObserver = null;
  let tableObserver = null;
  let observedTable = null;

  function norm(s) {
    return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  /** Legacy separate-column header (removed; used only to strip old injections). */
  const LEGACY_COLUMN_TITLE = "R'Lens";
  const LEGACY_COLUMN_TITLE_NORM = norm(LEGACY_COLUMN_TITLE);

  function findResultsContainer() {
    for (const sel of RESULTS_ROOT_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.isConnected) return el;
      } catch {
        /* invalid selector in older engines */
      }
    }
    const hit = findResultsTable();
    if (hit?.table) {
      const t = hit.table;
      return (
        t.closest('[id*="result" i], [class*="result" i], [id*="search" i]') ||
        t.parentElement ||
        t
      );
    }
    return null;
  }

  function findResultsTable() {
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const headerRow = findHeaderRow(table);
      if (!headerRow) continue;
      const texts = Array.from(headerRow.cells).map((c) => norm(c.textContent));
      const joined = texts.join("|");
      const keyHits = [
        joined.includes("crn"),
        joined.includes("subject"),
        joined.includes("section"),
        joined.includes("title"),
        joined.includes("instructor") || joined.includes("instruct"),
      ].filter(Boolean).length;
      if (keyHits >= 4) {
        return { table, headerRow, headerTexts: texts };
      }
    }
    return null;
  }

  function findHeaderRow(table) {
    const thead = table.tHead;
    if (thead && thead.rows.length) {
      return pickBestHeaderRow(thead.rows);
    }
    const firstBodies = table.tBodies[0];
    if (firstBodies && firstBodies.rows.length) {
      const r0 = firstBodies.rows[0];
      if (r0 && r0.cells.length && r0.cells[0].tagName === "TH") {
        return r0;
      }
    }
    if (table.rows.length) {
      const r0 = table.rows[0];
      if (r0 && r0.cells.length && r0.cells[0].tagName === "TH") {
        return r0;
      }
    }
    return null;
  }

  function pickBestHeaderRow(rowCollection) {
    let best = null;
    let bestScore = -1;
    for (const row of rowCollection) {
      const texts = Array.from(row.cells).map((c) => norm(c.textContent));
      const score = texts.filter((t) =>
        ["crn", "subject", "instructor", "title", "section"].some((k) => t.includes(k))
      ).length;
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    return best;
  }

  function findColIndex(headerTexts, predicate) {
    for (let i = 0; i < headerTexts.length; i++) {
      if (predicate(headerTexts[i], i)) return i;
    }
    return -1;
  }

  function findDeliveryColumnIndex(headerTexts) {
    return findColIndex(headerTexts, (t) => /course\s*delivery|delivery/.test(t));
  }

  function findLegacyDataColumnIndex(headerRow) {
    const headerTexts = Array.from(headerRow.cells).map((c) => norm(c.textContent));
    for (let i = 0; i < headerRow.cells.length; i++) {
      const c = headerRow.cells[i];
      const n = headerTexts[i];
      if (
        c.classList.contains(LEGACY_HEADER_CLASS) ||
        n === LEGACY_COLUMN_TITLE_NORM ||
        n === "data"
      ) {
        return i;
      }
    }
    return -1;
  }

  /** Remove the old R'Lens / Data column and colgroup entry from prior extension versions. */
  function removeLegacyDataColumn(table, headerRow) {
    const legacyIdx = findLegacyDataColumnIndex(headerRow);
    if (legacyIdx < 0) {
      table.querySelector("col[data-ucrd-data-col='1']")?.remove();
      return;
    }

    table.querySelector("col[data-ucrd-data-col='1']")?.remove();
    if (headerRow.cells[legacyIdx]) headerRow.deleteCell(legacyIdx);

    for (const tr of Array.from(table.rows)) {
      if (tr === headerRow) continue;
      const parentTag = tr.parentElement?.tagName;
      if (parentTag === "THEAD" || parentTag === "TFOOT") continue;
      const cell = tr.cells[legacyIdx];
      if (!cell) continue;
      if (
        cell.classList.contains(LEGACY_CELL_CLASS) ||
        cell.classList.contains(LEGACY_HEADER_CLASS) ||
        cell.querySelector(".ucrd-data-stack")
      ) {
        tr.deleteCell(legacyIdx);
      }
    }
  }

  const UCRD_TAB = {
    GPA: "gpa",
    RMP: "rmp",
    DIFF: "diff",
    AI: "ai",
  };

  /** Letter-grade columns on AggregateGradeDistribution / GradeDistribution (GraphQL field names). */
  const GRADE_LETTER_FIELDS = [
    { label: "A+", key: "gradeAPlus" },
    { label: "A", key: "gradeA" },
    { label: "A-", key: "gradeAMinus" },
    { label: "B+", key: "gradeBPlus" },
    { label: "B", key: "gradeB" },
    { label: "B-", key: "gradeBMinus" },
    { label: "C+", key: "gradeCPlus" },
    { label: "C", key: "gradeC" },
    { label: "C-", key: "gradeCMinus" },
    { label: "D+", key: "gradeDPlus" },
    { label: "D", key: "gradeD" },
    { label: "D-", key: "gradeDMinus" },
    { label: "F", key: "gradeF" },
  ];

  const UCRD_RMP_SEARCH = "https://www.ratemyprofessors.com/search/professors/1076";
  const UCRD_GRADES_SHEET =
    "https://docs.google.com/spreadsheets/d/1qiy_Oi8aFiPmL4QSTR3zHe74kmvc6e_159L1mAUUlU0/edit";

  function clamp01(n) {
    return Math.max(0, Math.min(1, Number(n) || 0));
  }

  function goodToBadColor(t) {
    const x = clamp01(t);
    const h = 130 - 130 * x;
    return `hsl(${h}, 65%, 38%)`;
  }

  function styleValueGoodHigh(el, value, min, max, decimals) {
    if (!el) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const nrm = (v - min) / Math.max(1e-6, max - min);
    el.style.color = goodToBadColor(1 - clamp01(nrm));
    el.style.fontWeight = "800";
    el.textContent = Number(v).toFixed(decimals);
  }

  function styleValueGoodLow(el, value, min, max, decimals) {
    if (!el) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const nrm = (v - min) / Math.max(1e-6, max - min);
    el.style.color = goodToBadColor(clamp01(nrm));
    el.style.fontWeight = "800";
    el.textContent = Number(v).toFixed(decimals);
  }

  function formatRatingMaybe(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    return `${Number(v).toFixed(1)}`;
  }

  function formatPercentMaybe(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    return `${Math.round(Number(v))}%`;
  }

  function normRmpCourseKey(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9]/g, "")
      .trim();
  }

  function rmpCourseMatchesReview(courseCode, reviewClass) {
    const want = normRmpCourseKey(courseCode);
    const got = normRmpCourseKey(reviewClass);
    if (!want || !got) return false;
    if (want === got) return true;
    if (got.includes(want) || want.includes(got)) return true;
    const wantDigits = want.replace(/\D/g, "");
    const gotDigits = got.replace(/\D/g, "");
    return wantDigits.length >= 2 && wantDigits === gotDigits;
  }

  function formatRmpReviewDate(raw) {
    const d = Date.parse(raw);
    if (!Number.isFinite(d)) return null;
    return new Date(d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function rmpQualityTone(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return "neutral";
    if (n >= 4) return "good";
    if (n >= 3) return "mid";
    return "low";
  }

  function renderRmpDistributionHtml(dist) {
    if (!dist || typeof dist !== "object") return "";
    const total = Number(dist.total);
    const rows = [
      { label: "Awesome", key: "r5", stars: 5 },
      { label: "Great", key: "r4", stars: 4 },
      { label: "Good", key: "r3", stars: 3 },
      { label: "OK", key: "r2", stars: 2 },
      { label: "Awful", key: "r1", stars: 1 },
    ];
    const denom =
      Number.isFinite(total) && total > 0
        ? total
        : rows.reduce((acc, r) => acc + (Number(dist[r.key]) || 0), 0);
    if (!denom) return "";
    const bars = rows
      .map((r) => {
        const count = Number(dist[r.key]) || 0;
        const pct = Math.round((count / denom) * 100);
        return [
          '<div class="ucrd-rmp-dist-row">',
          '<span class="ucrd-rmp-dist-label">',
          escapeHtml(r.label),
          "</span>",
          '<span class="ucrd-rmp-dist-stars" aria-hidden="true">',
          "★".repeat(r.stars),
          "</span>",
          '<div class="ucrd-rmp-dist-track" role="presentation">',
          '<div class="ucrd-rmp-dist-fill" style="width:',
          pct,
          '%"></div></div>',
          '<span class="ucrd-rmp-dist-count">',
          count,
          "</span>",
          "</div>",
        ].join("");
      })
      .join("");
    return [
      '<div class="ucrd-rmp-dist">',
      '<h3 class="ucrd-gpa-subhead">Rating distribution</h3>',
      '<div class="ucrd-rmp-dist-rows">',
      bars,
      "</div></div>",
    ].join("");
  }

  function renderRmpReviewCard(review, opts = {}) {
    const quality = formatRatingMaybe(review.quality);
    const difficulty = formatRatingMaybe(review.difficulty);
    const qTone = rmpQualityTone(review.quality);
    const meta = [];
    if (review.isForCredit === true) meta.push("For credit");
    if (review.attendance) meta.push("Attendance: " + String(review.attendance));
    if (review.wouldTakeAgain === true) meta.push("Would take again");
    else if (review.wouldTakeAgain === false) meta.push("Would not take again");
    if (review.grade) meta.push("Grade: " + review.grade);
    if (review.textbook) meta.push("Textbook: " + review.textbook);
    const metaHtml = meta.length
      ? '<p class="ucrd-rmp-review-meta">' +
        meta.map((t) => escapeHtml(t)).join(" · ") +
        "</p>"
      : "";
    const tags = Array.isArray(review.tags) ? review.tags : [];
    const tagsHtml = tags.length
      ? '<div class="ucrd-rmp-tags">' +
        tags
          .slice(0, 6)
          .map((t) => '<span class="ucrd-rmp-tag">' + escapeHtml(t) + "</span>")
          .join("") +
        "</div>"
      : "";
    const courseBadge = opts.courseMatch
      ? '<span class="ucrd-rmp-course-badge">This course</span>'
      : "";
    const dateStr = formatRmpReviewDate(review.date);
    return [
      '<article class="ucrd-rmp-review',
      opts.courseMatch ? " ucrd-rmp-review-match" : "",
      '">',
      '<div class="ucrd-rmp-review-scores">',
      '<div class="ucrd-rmp-score ucrd-rmp-score-quality ucrd-rmp-score-',
      qTone,
      '">',
      '<span class="ucrd-rmp-score-label">Quality</span>',
      '<span class="ucrd-rmp-score-val">',
      escapeHtml(quality || "—"),
      "</span></div>",
      '<div class="ucrd-rmp-score ucrd-rmp-score-diff">',
      '<span class="ucrd-rmp-score-label">Difficulty</span>',
      '<span class="ucrd-rmp-score-val">',
      escapeHtml(difficulty || "—"),
      "</span></div></div>",
      '<div class="ucrd-rmp-review-body">',
      '<div class="ucrd-rmp-review-head">',
      '<strong class="ucrd-rmp-review-class">',
      escapeHtml(review.class || "—"),
      "</strong>",
      courseBadge,
      dateStr
        ? '<span class="ucrd-rmp-review-date">' + escapeHtml(dateStr) + "</span>"
        : "",
      "</div>",
      metaHtml,
      review.comment
        ? '<p class="ucrd-rmp-review-text">' + escapeHtml(review.comment) + "</p>"
        : "",
      tagsHtml,
      "</div></article>",
    ].join("");
  }

  let ucrdModalEl = null;
  let ucrdModalEscapeHandler = null;
  /** Row context for the open modal — used to refresh AI after API key / mode changes. */
  let ucrdModalLoadCtx = null;
  /** Latest MyClassGrades payload for the open modal GPA panel (recent-terms filter). */
  let ucrdGpaPanelPayload = null;
  let ucrdMcgInstructor = "";
  let ucrdMcgTermKey = "";

  let ucrdGradeTipEl = null;
  let ucrdGradeTipTimer = null;

  function ensureGradeTooltipFloater() {
    if (ucrdGradeTipEl?.isConnected) return ucrdGradeTipEl;
    ucrdGradeTipEl = document.createElement("div");
    ucrdGradeTipEl.className = "ucrd-grade-tooltip-float";
    ucrdGradeTipEl.setAttribute("hidden", "");
    (document.body || document.documentElement).appendChild(ucrdGradeTipEl);
    return ucrdGradeTipEl;
  }

  function hideGradeChartTooltip() {
    if (ucrdGradeTipTimer) {
      clearTimeout(ucrdGradeTipTimer);
      ucrdGradeTipTimer = null;
    }
    if (ucrdGradeTipEl) ucrdGradeTipEl.setAttribute("hidden", "");
  }

  function fillAndPositionGradeTooltip(col) {
    const tip = ensureGradeTooltipFloater();
    const label = col.getAttribute("data-ucrd-grade-label") || "";
    const count = col.getAttribute("data-ucrd-grade-count") || "0";
    const pct = col.getAttribute("data-ucrd-grade-pct") || "0.0";
    const countStr = Number(count).toLocaleString();
    tip.innerHTML = `<div class="ucrd-grade-tip-title">${escapeHtml(label)}</div><div class="ucrd-grade-tip-line"><span>Students</span><strong>${escapeHtml(
      countStr
    )}</strong></div><div class="ucrd-grade-tip-line"><span>% of students</span><strong>${escapeHtml(pct)}%</strong></div>`;
    tip.removeAttribute("hidden");
    tip.style.position = "fixed";
    tip.style.zIndex = "2147483646";
    void tip.offsetWidth;
    const r = col.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const pad = 8;
    let left = r.left + r.width / 2 - tw / 2;
    let top = r.top - th - pad;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    if (top < pad) top = r.bottom + pad;
    top = Math.max(pad, Math.min(top, window.innerHeight - th - pad));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  /** Letter-grade charts use flex `gap`; the gap is not inside `.ucrd-grade-col`, so resolve the column from pointer X/Y instead of mouseover/mouseout. */
  function findGradeColumnForPointer(chart, clientX, clientY) {
    if (!chart || !(chart instanceof Element)) return null;
    const outer = chart.getBoundingClientRect();
    if (
      clientX < outer.left ||
      clientX > outer.right ||
      clientY < outer.top ||
      clientY > outer.bottom
    ) {
      return null;
    }
    const cols = chart.querySelectorAll(".ucrd-grade-col[data-ucrd-grade-label]");
    if (!cols.length) return null;
    for (const col of cols) {
      const b = col.getBoundingClientRect();
      if (clientX >= b.left && clientX <= b.right && clientY >= b.top && clientY <= b.bottom) {
        return col;
      }
    }
    let best = null;
    let bestDist = Infinity;
    for (const col of cols) {
      const b = col.getBoundingClientRect();
      const mid = (b.left + b.right) / 2;
      const d = Math.abs(clientX - mid);
      if (d < bestDist) {
        bestDist = d;
        best = col;
      }
    }
    return best;
  }

  function wireGradeChartTooltipsOnce() {
    if (window.__ucrdGradeTipWired) return;
    window.__ucrdGradeTipWired = true;
    const scheduleHideWhenOutsideChart = () => {
      if (ucrdGradeTipTimer) return;
      ucrdGradeTipTimer = window.setTimeout(() => {
        ucrdGradeTipTimer = null;
        hideGradeChartTooltip();
      }, 60);
    };
    document.addEventListener(
      "mousemove",
      (e) => {
        let el = e.target instanceof Element ? e.target : null;
        if (!el && e.target && /** @type {Node} */ (e.target).parentElement) {
          el = /** @type {Node} */ (e.target).parentElement;
        }
        if (!(el instanceof Element)) return;
        let chart = el.closest(".ucrd-grade-chart, .ucrd-mini-chart");
        if (!chart) {
          const under = document.elementFromPoint(e.clientX, e.clientY);
          chart =
            under instanceof Element ? under.closest(".ucrd-grade-chart, .ucrd-mini-chart") : null;
        }
        if (!chart) {
          scheduleHideWhenOutsideChart();
          return;
        }
        if (ucrdGradeTipTimer) {
          clearTimeout(ucrdGradeTipTimer);
          ucrdGradeTipTimer = null;
        }
        const col = findGradeColumnForPointer(chart, e.clientX, e.clientY);
        if (col) fillAndPositionGradeTooltip(col);
      },
      true
    );
    window.addEventListener("scroll", hideGradeChartTooltip, true);
    window.addEventListener("resize", hideGradeChartTooltip);
  }

  function uniqueStrings(arr) {
    const out = [];
    const seen = new Set();
    for (const x of arr || []) {
      const s = String(x || "").trim();
      if (!s || seen.has(norm(s))) continue;
      seen.add(norm(s));
      out.push(s);
    }
    return out;
  }

  /**
   * Split one blob into likely separate instructor tokens (still need normalizeInstructorLine).
   * Handles: newlines; "(Primary) NextLast" jammed on one line; bare "Primary" as delimiter.
   */
  function splitInstructorBlobIntoPieces(blob) {
    let s = String(blob || "").replace(/\s+/g, " ").trim();
    if (!s) return [];
    let pieces = [s];
    pieces = pieces
      .flatMap((p) => p.split(/(?<=\))\s+(?=[A-Za-z])/g))
      .map((x) => x.trim())
      .filter(Boolean);
    pieces = pieces
      .flatMap((p) => p.split(/(?<!\()\bPrimary\b(?!\))/gi))
      .map((x) => x.trim())
      .filter(Boolean);
    return pieces;
  }

  /** Banner-style "LAST, FIRST ..." → "FIRST ... LAST" for matching API names. */
  function normalizeInstructorLine(line) {
    let s = String(line || "").trim();
    s = s.replace(/\([^)]*primary[^)]*\)/gi, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    if (!s || /^tba$/i.test(s) || /^staff$/i.test(s)) return "";
    if (/^primary$/i.test(s)) return "";
    const m = s.match(/^([^,]+),\s*(.+)$/);
    if (m) {
      const last = m[1].trim();
      const rest = m[2]
        .trim()
        .replace(/\s*\([^)]*\)\s*$/g, "")
        .trim();
      return `${rest} ${last}`.replace(/\s+/g, " ").trim();
    }
    return s.replace(/\s+/g, " ").trim();
  }

  /**
   * Parses the instructor cell: splits multiple professors, finds (Primary) line when present.
   * `sheetProfessorQuery` is a single name string for sheet/RMP-primary (never the whole roster blob).
   */
  function parseInstructorsFromCell(raw) {
    const instructorRaw = String(raw || "").trim();
    if (!instructorRaw) {
      return {
        primaryInstructorLabel: "—",
        professorNames: [],
        sheetProfessorQuery: "",
        instructorRaw: "",
      };
    }

    const coarseLines = instructorRaw
      .split(/\r?\n|;|•|·|\s+\/\s+/g)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const primaryLineMarked = coarseLines.find((l) => /\(primary\)/i.test(l));
    let primaryInstructorLabel = "—";

    if (primaryLineMarked) {
      const parts = splitInstructorBlobIntoPieces(primaryLineMarked);
      const norms = parts.map(normalizeInstructorLine).filter(Boolean);
      primaryInstructorLabel = norms[0] || normalizeInstructorLine(primaryLineMarked) || "—";
    } else {
      const barePrimaryLine = coarseLines.find(
        (l) => /(?<!\()\bPrimary\b(?!\))/i.test(l) && !/\(primary\)/i.test(l)
      );
      if (barePrimaryLine) {
        const segs = barePrimaryLine
          .split(/(?<!\()\bPrimary\b(?!\))/gi)
          .map((x) => x.trim())
          .filter(Boolean);
        primaryInstructorLabel = normalizeInstructorLine(segs[0]) || "—";
      }
    }

    let allPieces = uniqueStrings(
      coarseLines.flatMap((line) => splitInstructorBlobIntoPieces(line)).map(normalizeInstructorLine).filter(Boolean)
    );
    if (!allPieces.length && instructorRaw) {
      const one = normalizeInstructorLine(instructorRaw);
      if (one) allPieces = [one];
    }

    if (primaryInstructorLabel === "—" && allPieces.length) {
      primaryInstructorLabel = allPieces[0];
    }

    const professorNames = uniqueStrings(
      primaryInstructorLabel !== "—" ? [primaryInstructorLabel, ...allPieces] : allPieces
    );

    const sheetProfessorQuery =
      primaryInstructorLabel !== "—" ? primaryInstructorLabel : professorNames[0] || "";

    return {
      primaryInstructorLabel,
      professorNames,
      sheetProfessorQuery,
      instructorRaw,
    };
  }

  function fmtGpa(x) {
    if (x == null || Number.isNaN(x)) return "—";
    const n = Number(x);
    return (Math.round(n * 100) / 100).toFixed(2);
  }

  function pctPart(n, total) {
    if (!total || n == null) return "0.0";
    return ((100 * Number(n)) / total).toFixed(1);
  }

  function aggregateLetterCounts(agg) {
    if (!agg) return [];
    let max = 0;
    const rows = GRADE_LETTER_FIELDS.map(({ label, key }) => {
      const c = Number(agg[key]) || 0;
      if (c > max) max = c;
      return { label, count: c };
    });
    return { rows, max: max || 1 };
  }

  function rowLetterCounts(row) {
    if (!row) return { rows: [], max: 1 };
    let max = 0;
    const rows = GRADE_LETTER_FIELDS.map(({ label, key }) => {
      const c = Number(row[key]) || 0;
      if (c > max) max = c;
      return { label, count: c };
    });
    return { rows, max: max || 1 };
  }

  function renderLetterBarsFromRows(rowModel, chartClass, totalStudentsForPct) {
    const { rows, max } = rowModel;
    const letterSum = rows.reduce((s, r) => s + (Number(r.count) || 0), 0);
    const denom =
      totalStudentsForPct != null && Number(totalStudentsForPct) > 0
        ? Number(totalStudentsForPct)
        : letterSum > 0
          ? letterSum
          : 1;

    return rows
      .map((r, i) => {
        const count = Number(r.count) || 0;
        const pctBar = max ? Math.round((100 * count) / max) : 0;
        const pctStudents = denom > 0 ? ((100 * count) / denom).toFixed(1) : "0.0";
        const cls = gradeBarColorClass(i, rows.length);
        return `<div class="ucrd-grade-col" role="presentation" data-ucrd-grade-label="${escapeHtml(
          r.label
        )}" data-ucrd-grade-count="${count}" data-ucrd-grade-pct="${escapeHtml(pctStudents)}"><div class="ucrd-grade-bar-track"><div class="ucrd-grade-bar ${cls} ${chartClass}" style="height:${pctBar}%"></div></div><div class="ucrd-grade-label">${escapeHtml(
          r.label
        )}</div></div>`;
      })
      .join("");
  }

  function renderMiniTermChart(row) {
    const rm = rowLetterCounts(row);
    const hasAny = rm.rows.some((x) => x.count > 0);
    if (!hasAny) return `<span class="ucrd-term-nochart">—</span>`;
    const n = row?.totalStudents != null ? Number(row.totalStudents) : null;
    return `<div class="ucrd-mini-chart" aria-hidden="true">${renderLetterBarsFromRows(rm, "ucrd-mini-bar", n)}</div>`;
  }

  const MCG_CHART_BUCKETS = [
    { label: "A", keys: ["gradeAPlus", "gradeA", "gradeAMinus"], color: "#6b9bd1" },
    { label: "B", keys: ["gradeBPlus", "gradeB", "gradeBMinus"], color: "#8fad7a" },
    { label: "C", keys: ["gradeCPlus", "gradeC", "gradeCMinus"], color: "#e8d070" },
    { label: "D", keys: ["gradeDPlus", "gradeD", "gradeDMinus"], color: "#d4c4a8" },
    { label: "F", keys: ["gradeF"], color: "#d4926a" },
    { label: "P", keys: ["gradeS"], color: "#7fb069" },
    { label: "NP", keys: ["gradeNp"], color: "#e09868" },
  ];

  function primaryProfessorLabel(ctx) {
    const raw = String(ctx?.primaryInstructorLabel ?? "").trim();
    return raw && raw !== "\u2014" ? raw : "";
  }

  function mcgTermKey(row) {
    return String(row?.termCode || row?.termString || "").trim();
  }

  function mcgHistoryRows(payload) {
    return Array.isArray(payload?.gradeHistory) ? payload.gradeHistory : [];
  }

  function mcgUniqueInstructors(rows) {
    const map = new Map();
    for (const row of rows) {
      for (const ins of row.instructors || []) {
        const n = String(ins?.name || "").trim();
        if (n) map.set(n, n);
      }
    }
    return [...map.values()].sort((a, b) => a.localeCompare(b));
  }

  function mcgUniqueTerms(rows) {
    const map = new Map();
    for (const row of rows) {
      const key = mcgTermKey(row);
      if (!key) continue;
      const label = String(row.termString || key).trim();
      if (!map.has(key)) map.set(key, { key, label });
    }
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key, undefined, { numeric: true }));
  }

  function mcgRowMatchesInstructor(row, instructorValue) {
    if (!instructorValue || instructorValue === "__all__") return true;
    const inst = row.instructors || [];
    return inst.some((i) => namesLikelyMatch(i.name, [instructorValue]));
  }

  function mcgFilterHistory(payload, instructorValue, termKey) {
    let rows = mcgHistoryRows(payload);
    if (instructorValue && instructorValue !== "__all__") {
      rows = rows.filter((r) => mcgRowMatchesInstructor(r, instructorValue));
    }
    if (termKey) {
      rows = rows.filter((r) => mcgTermKey(r) === termKey);
    }
    return rows;
  }

  function mcgBucketCountsFromRow(row) {
    const out = { A: 0, B: 0, C: 0, D: 0, F: 0, P: 0, NP: 0 };
    for (const b of MCG_CHART_BUCKETS) {
      let sum = 0;
      for (const k of b.keys) sum += Number(row[k]) || 0;
      out[b.label] = sum;
    }
    return out;
  }

  function mcgAggregateBucketCounts(rows) {
    const out = { A: 0, B: 0, C: 0, D: 0, F: 0, P: 0, NP: 0 };
    for (const row of rows) {
      const bc = mcgBucketCountsFromRow(row);
      for (const lab of Object.keys(out)) out[lab] += bc[lab];
    }
    return out;
  }

  function mcgBucketTotal(buckets) {
    return MCG_CHART_BUCKETS.reduce((s, b) => s + (Number(buckets[b.label]) || 0), 0);
  }

  function mcgNiceYMax(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v <= 50) return 50;
    if (v <= 100) return 100;
    if (v <= 150) return 150;
    if (v <= 200) return 200;
    if (v <= 300) return 300;
    if (v <= 400) return 400;
    if (v <= 500) return 500;
    if (v <= 650) return 650;
    return Math.ceil(v / 100) * 100;
  }

  function mcgYTickStep(yMax) {
    if (yMax <= 100) return 50;
    if (yMax <= 300) return 50;
    return 100;
  }

  function mcgWeightedGpaFromRows(rows) {
    let sum = 0;
    let students = 0;
    for (const r of rows) {
      const ts = Number(r.totalStudents) || 0;
      const g = r.averageGpa;
      if (ts > 0 && g != null && !Number.isNaN(Number(g))) {
        sum += Number(g) * ts;
        students += ts;
      }
    }
    if (!students) return null;
    return Math.round((sum / students) * 100) / 100;
  }

  function mcgGpaToLetter(gpa) {
    const v = Number(gpa);
    if (!Number.isFinite(v)) return "\u2014";
    const bands = [
      [3.85, "A"],
      [3.5, "A-"],
      [3.15, "B+"],
      [2.85, "B"],
      [2.5, "B-"],
      [2.15, "C+"],
      [1.85, "C"],
      [1.5, "C-"],
      [1.15, "D+"],
      [0.85, "D"],
      [0.5, "D-"],
      [0, "F"],
    ];
    for (const [min, letter] of bands) {
      if (v >= min) return letter;
    }
    return "F";
  }

  function mcgResolveInstructor(ctx, instructors, requested) {
    if (requested && requested !== "__default__") return requested;
    const primary = primaryProfessorLabel(ctx);
    if (primary && instructors.some((n) => namesLikelyMatch(n, [primary]))) return primary;
    return "__all__";
  }

  function mcgAllTerms(payload) {
    return mcgUniqueTerms(mcgHistoryRows(payload));
  }

  function mcgResolveTerm(payload, _instructorValue, requested) {
    const terms = mcgAllTerms(payload);
    if (!terms.length) return "";
    if (requested && terms.some((t) => t.key === requested)) return requested;
    return terms[0].key;
  }

  function mcgTermLabel(terms, termKey) {
    const hit = terms.find((t) => t.key === termKey);
    return hit?.label || termKey || "Select term";
  }

  function mcgInstructorDisplayLabel(instVal, instructors) {
    if (instVal === "__all__") return "All Instructors";
    return instVal || instructors[0] || "Select instructor";
  }

  function mcgAggregateLetterCounts(rows) {
    const combined = {};
    for (const { key } of GRADE_LETTER_FIELDS) combined[key] = 0;
    for (const row of rows) {
      for (const { key } of GRADE_LETTER_FIELDS) {
        combined[key] += Number(row[key]) || 0;
      }
    }
    return aggregateLetterCounts(combined);
  }

  function renderMcgSelectShell(displayText, optionsHtml, selectAttrs) {
    return `<div class="ucrd-mcg-select-shell">
      <span class="ucrd-mcg-select-display" aria-hidden="true">${escapeHtml(displayText)}</span>
      <select class="ucrd-mcg-select"${selectAttrs}>${optionsHtml}</select>
    </div>`;
  }

  function mcgDonutGradient(buckets, total) {
    if (!total) return "background:#e5e7eb";
    const stops = [];
    let pct = 0;
    for (const b of MCG_CHART_BUCKETS) {
      const c = Number(buckets[b.label]) || 0;
      if (c <= 0) continue;
      const frac = (100 * c) / total;
      stops.push(`${b.color} ${pct}% ${pct + frac}%`);
      pct += frac;
    }
    if (!stops.length) return "background:#e5e7eb";
    return `background:conic-gradient(${stops.join(", ")})`;
  }

  function renderMcgBarChart(letterModel, yMax, letterTotal) {
    const { rows } = letterModel;
    const step = mcgYTickStep(yMax);
    const ticks = [];
    for (let v = 0; v <= yMax; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] !== yMax) ticks.push(yMax);
    const yAxis = ticks
      .slice()
      .reverse()
      .map((v) => `<span class="ucrd-mcg-ytick">${Number(v).toLocaleString()}</span>`)
      .join("");
    const gridLines = ticks
      .slice()
      .reverse()
      .map((v) => {
        const pct = yMax ? (100 * v) / yMax : 0;
        return `<span class="ucrd-mcg-gridline" style="bottom:${pct}%"></span>`;
      })
      .join("");
    const denom = letterTotal > 0 ? letterTotal : 1;
    const n = rows.length;
    const bars = rows.map((r, i) => {
      const count = Number(r.count) || 0;
      const pctBar = yMax ? Math.round((100 * count) / yMax) : 0;
      const pctStudents = ((100 * count) / denom).toFixed(1);
      const cls = gradeBarColorClass(i, n);
      return `<div class="ucrd-grade-col ucrd-mcg-bar-col" role="presentation" data-ucrd-grade-label="${escapeHtml(
        r.label
      )}" data-ucrd-grade-count="${count}" data-ucrd-grade-pct="${escapeHtml(pctStudents)}"><div class="ucrd-grade-bar-track"><div class="ucrd-mcg-bar-fill ${cls}" style="height:${pctBar}%"></div></div></div>`;
    }).join("");
    const xLabels = rows
      .map((r) => `<span class="ucrd-mcg-xlabel">${escapeHtml(r.label)}</span>`)
      .join("");
    return `<div class="ucrd-mcg-bar-panel">
      <div class="ucrd-mcg-bar-yaxis" aria-hidden="true">${yAxis}</div>
      <div class="ucrd-mcg-bar-main">
        <div class="ucrd-mcg-bar-grid" aria-hidden="true">${gridLines}</div>
        <div class="ucrd-mcg-bar-chart ucrd-mcg-bar-chart-detailed ucrd-grade-chart" aria-hidden="true">${bars}</div>
        <div class="ucrd-mcg-bar-xaxis" aria-hidden="true">${xLabels}</div>
      </div>
    </div>`;
  }

  function renderMcgDonut(buckets, letterTotal, avgGpa, pnpCount) {
    const grad = mcgDonutGradient(buckets, letterTotal);
    const letter = mcgGpaToLetter(avgGpa);
    const gpaStr = avgGpa != null ? fmtGpa(avgGpa) : "\u2014";
    const enrolled = letterTotal ? Number(letterTotal).toLocaleString() : "\u2014";
    const pnp = pnpCount ? Number(pnpCount).toLocaleString() : "0";
    return `<div class="ucrd-mcg-donut-wrap">
      <div class="ucrd-mcg-donut" style="${grad}" aria-hidden="true"></div>
      <div class="ucrd-mcg-donut-center">
        <p class="ucrd-mcg-donut-line">Average Grade: <strong>${escapeHtml(letter)} (${escapeHtml(gpaStr)})</strong></p>
        <p class="ucrd-mcg-donut-line">Total Enrolled: <strong>${escapeHtml(enrolled)}</strong></p>
        <p class="ucrd-mcg-donut-sub">${escapeHtml(pnp)} enrolled as P/NP</p>
      </div>
    </div>`;
  }

  function renderMcgDashboardSection(payload, ctx, instructorValue, termKey) {
    const history = mcgHistoryRows(payload);
    if (!history.length) {
      return `<p class="ucrd-gpa-muted">No published grade breakdown for this course.</p>`;
    }
    const instructors = mcgUniqueInstructors(history);
    const instVal = mcgResolveInstructor(ctx, instructors, instructorValue || "__default__");
    const termVal = mcgResolveTerm(payload, instVal, termKey);
    const termsForInst = mcgUniqueTerms(mcgFilterHistory(payload, instVal, null));
    const filtered = mcgFilterHistory(payload, instVal, termVal);
    const buckets = mcgAggregateBucketCounts(filtered);
    const letterTotal = mcgBucketTotal(buckets);
    const yMax = mcgNiceYMax(Math.max(...MCG_CHART_BUCKETS.map((b) => buckets[b.label] || 0)));
    const avgGpa = mcgWeightedGpaFromRows(filtered);
    const pnpCount = (Number(buckets.P) || 0) + (Number(buckets.NP) || 0);

    const instOptions = [
      `<option value="__all__"${instVal === "__all__" ? " selected" : ""}>All Instructors</option>`,
      ...instructors.map((n) => {
        const sel = instVal === n ? " selected" : "";
        return `<option value="${escapeHtml(n)}"${sel}>${escapeHtml(n)}</option>`;
      }),
    ].join("");
    const termOptions = termsForInst
      .map((t) => {
        const sel = termVal === t.key ? " selected" : "";
        return `<option value="${escapeHtml(t.key)}"${sel}>${escapeHtml(t.label)}</option>`;
      })
      .join("");

    if (!filtered.length) {
      return `<section class="ucrd-mcg-dashboard" data-ucrd-mcg-dashboard>
        <div class="ucrd-mcg-filters">
          <label class="ucrd-mcg-select-wrap"><span class="ucrd-sr-only">Instructor</span>
            <select class="ucrd-mcg-select" data-ucrd-mcg-instructor>${instOptions}</select></label>
          <label class="ucrd-mcg-select-wrap"><span class="ucrd-sr-only">Term</span>
            <select class="ucrd-mcg-select" data-ucrd-mcg-term>${termOptions || '<option value="">No terms</option>'}</select></label>
        </div>
        <p class="ucrd-gpa-muted">No sections match these filters.</p>
      </section>`;
    }

    return `<section class="ucrd-mcg-dashboard" data-ucrd-mcg-dashboard data-ucrd-mcg-instructor="${escapeHtml(
      instVal
    )}" data-ucrd-mcg-term="${escapeHtml(termVal)}">
      <div class="ucrd-mcg-filters">
        <label class="ucrd-mcg-select-wrap"><span class="ucrd-sr-only">Instructor</span>
          <select class="ucrd-mcg-select" data-ucrd-mcg-instructor>${instOptions}</select></label>
        <label class="ucrd-mcg-select-wrap"><span class="ucrd-sr-only">Term</span>
          <select class="ucrd-mcg-select" data-ucrd-mcg-term>${termOptions}</select></label>
      </div>
      <div class="ucrd-mcg-layout">
        <div class="ucrd-mcg-left">${renderMcgBarChart(buckets, yMax, letterTotal)}</div>
        <div class="ucrd-mcg-right">${renderMcgDonut(buckets, letterTotal, avgGpa, pnpCount)}</div>
      </div>
    </section>`;
  }

  function applyMcgDashboardUpdate(instructorValue, termKey) {
    ucrdMcgInstructor = instructorValue || "__all__";
    ucrdMcgTermKey = termKey || "";
    const panel = ucrdModalEl?.querySelector(`[data-ucrd-panel="${UCRD_TAB.GPA}"]`);
    const mount = panel?.querySelector("[data-ucrd-mcg-mount]");
    if (!mount || !ucrdGpaPanelPayload || !ucrdModalLoadCtx) return;
    mount.innerHTML = renderMcgDashboardSection(
      ucrdGpaPanelPayload,
      ucrdModalLoadCtx,
      ucrdMcgInstructor,
      ucrdMcgTermKey
    );
  }

  function handleMcgSelectChange(target) {
    if (!(target instanceof HTMLSelectElement)) return;
    const panel = target.closest(`[data-ucrd-panel="${UCRD_TAB.GPA}"]`);
    if (!panel || !ucrdGpaPanelPayload) return;
    const instSel = panel.querySelector("[data-ucrd-mcg-instructor]");
    const termSel = panel.querySelector("[data-ucrd-mcg-term]");
    const inst = instSel?.value || "__all__";
    let term = termSel?.value || "";
    if (target === instSel) {
      term = mcgResolveTerm(ucrdGpaPanelPayload, inst, "");
    }
    applyMcgDashboardUpdate(inst, term);
  }


  function requestMyClassGrades(ctx, cb) {
    const courseCode = ctx?.courseCode;
    const professorNames = ctx?.professorNames || [];
    const primaryInstructor = ctx?.primaryInstructorLabel || "";
    try {
      chrome.runtime.sendMessage(
        { type: "FETCH_MYCLASSGRADES", courseCode, professorNames, primaryInstructor },
        (response) => {
          if (chrome.runtime.lastError) {
            cb({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          cb(response && typeof response === "object" ? response : { ok: false, error: "Empty response" });
        }
      );
    } catch (e) {
      cb({ ok: false, error: e?.message || String(e) });
    }
  }

  function stripCached(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const { cached: _c, ...rest } = obj;
    return rest;
  }

  function loadGeminiSources(ctx) {
    const profs = Array.isArray(ctx?.professorNames) ? ctx.professorNames : [];
    const sheetProf =
      String(ctx?.sheetProfessorQuery ?? "").trim() ||
      (ctx?.primaryInstructorLabel && ctx.primaryInstructorLabel !== "—" ? ctx.primaryInstructorLabel : "") ||
      (profs.length ? profs[0] : "");
    const rmpTarget =
      ctx?.primaryInstructorLabel && ctx.primaryInstructorLabel !== "—"
        ? ctx.primaryInstructorLabel
        : profs[0] || "";

    return Promise.all([
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            {
              type: "FETCH_MYCLASSGRADES",
              courseCode: ctx.courseCode,
              professorNames: profs,
              primaryInstructor: ctx.primaryInstructorLabel || "",
            },
            (r) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve(r && r.ok ? stripCached(r) : null);
            }
          );
        } catch {
          resolve(null);
        }
      }),
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { type: "FETCH_SHEET_GRADES", courseCode: ctx.courseCode, professorName: sheetProf },
            (r) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve(r && r.ok ? r.data : null);
            }
          );
        } catch {
          resolve(null);
        }
      }),
      new Promise((resolve) => {
        if (!rmpTarget) {
          resolve(null);
          return;
        }
        try {
          chrome.runtime.sendMessage({ type: "FETCH_RMP", profName: rmpTarget }, (r) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(r && r.ok ? r.data : null);
          });
        } catch {
          resolve(null);
        }
      }),
    ]).then(([mcgPayload, sheetData, rmpData]) => {
      const profKey = (profs[0] || "").replace(/\s+/g, "");
      return {
        profKey,
        sources: {
          rmp: rmpData,
          courseData: mcgPayload ?? { ok: false },
          difficultyDatabase: sheetData,
        },
      };
    });
  }

  function syncAiGeminiSettingsBar(panelEl) {
    if (!panelEl || typeof panelEl.querySelector !== "function") return;
    const toggle = panelEl.querySelector("[data-ucrd-ai-mode-toggle]");
    const input = panelEl.querySelector("[data-ucrd-gemini-api-key]");
    if (!toggle || !input) return;
    try {
      chrome.storage.local.get(["geminiApiKey", "geminiAiEnabled"], (r) => {
        if (chrome.runtime.lastError || !panelEl.isConnected) return;
        const t = panelEl.querySelector("[data-ucrd-ai-mode-toggle]");
        const inp = panelEl.querySelector("[data-ucrd-gemini-api-key]");
        if (!t || !inp) return;
        const on = r.geminiAiEnabled !== false;
        t.classList.toggle("ucrd-ai-toggle-on", on);
        t.setAttribute("aria-checked", on ? "true" : "false");
        inp.value = "";
        inp.placeholder = String(r.geminiApiKey ?? "").trim() ? "AIza..." : "Paste Gemini API key";
      });
    } catch {
      /* ignore */
    }
  }

  function replaceDataPanel(tab, html) {
    const prev = ucrdModalEl?.querySelector(`[data-ucrd-panel="${tab}"]`);
    if (!prev || !ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = html.trim();
    const nu = wrap.firstElementChild;
    if (nu) {
      const wasHidden = prev.hidden;
      prev.replaceWith(nu);
      if (wasHidden) nu.hidden = true;
      if (tab === UCRD_TAB.AI) syncAiGeminiSettingsBar(nu);
    }
  }

  function replaceGpaPanel(html) {
    replaceDataPanel(UCRD_TAB.GPA, html);
  }

  function renderRmpPanelHtml(ctx, st) {
    const prof =
      ctx?.primaryInstructorLabel && ctx.primaryInstructorLabel !== "—"
        ? ctx.primaryInstructorLabel
        : (ctx?.professorNames && ctx.professorNames[0]) || "";
    const searchUrl = `${UCRD_RMP_SEARCH}?q=${encodeURIComponent(prof || "professor")}`;

    if (st.status === "loading") {
      return `<div class="ucrd-panel ucrd-panel-rmp" data-ucrd-panel="${UCRD_TAB.RMP}"><p class="ucrd-gpa-muted ucrd-gpa-loading">Loading professor ratings…</p></div>`;
    }
    if (st.status === "noprof") {
      return `<div class="ucrd-panel ucrd-panel-rmp" data-ucrd-panel="${UCRD_TAB.RMP}"><h2 class="ucrd-gpa-headline">RateMyProfessor</h2><p class="ucrd-gpa-muted">No instructor on this row to look up.</p><p class="ucrd-gpa-muted"><a class="ucrd-ext-link" href="${escapeHtml(
        searchUrl
      )}" target="_blank" rel="noreferrer">Open RMP search</a></p></div>`;
    }
    if (st.status === "error") {
      return `<div class="ucrd-panel ucrd-panel-rmp" data-ucrd-panel="${UCRD_TAB.RMP}"><h2 class="ucrd-gpa-headline">RateMyProfessor</h2><p class="ucrd-gpa-error">${escapeHtml(
        st.message || "Could not load RMP."
      )}</p><p class="ucrd-gpa-muted"><a class="ucrd-ext-link" href="${escapeHtml(
        searchUrl
      )}" target="_blank" rel="noreferrer">Search on RateMyProfessors</a></p></div>`;
    }

    const data = st.data || {};
    if (!data.found) {
      const hint = data.useSearchFallback
        ? `<p class="ucrd-gpa-muted">No confident match — try the search link below.</p>`
        : "";
      return `<div class="ucrd-panel ucrd-panel-rmp" data-ucrd-panel="${UCRD_TAB.RMP}">
        <h2 class="ucrd-gpa-headline">RateMyProfessor</h2>
        <p class="ucrd-gpa-muted">Instructor: <strong>${escapeHtml(prof || "—")}</strong></p>
        ${hint}
        <p class="ucrd-gpa-muted"><a class="ucrd-ext-link" href="${escapeHtml(searchUrl)}" target="_blank" rel="noreferrer">Open UCR RMP search</a></p>
      </div>`;
    }

    const displayName =
      [data.firstName, data.lastName].filter(Boolean).join(" ").trim() || prof || "—";
    const profileUrl = data.profileUrl || searchUrl;
    const rating = formatRatingMaybe(data.avgRating);
    const wta = formatPercentMaybe(data.wouldTakeAgainPercent);
    const difficulty = formatRatingMaybe(data.avgDifficulty);
    const num = data.numRatings == null ? null : Number(data.numRatings);
    const dept = data.department ? String(data.department) : "";
    const school = data.schoolName ? String(data.schoolName) : "University of California Riverside";
    const subline = [dept, school].filter(Boolean).join(" · ");

    const statPills = [
      wta
        ? `<div class="ucrd-rmp-stat"><span class="ucrd-rmp-stat-val">${escapeHtml(wta)}</span><span class="ucrd-rmp-stat-label">Would take again</span></div>`
        : "",
      difficulty
        ? `<div class="ucrd-rmp-stat"><span class="ucrd-rmp-stat-val">${escapeHtml(difficulty)}</span><span class="ucrd-rmp-stat-label">Difficulty</span></div>`
        : "",
      Number.isFinite(num)
        ? `<div class="ucrd-rmp-stat"><span class="ucrd-rmp-stat-val">${num}</span><span class="ucrd-rmp-stat-label">Ratings</span></div>`
        : "",
    ]
      .filter(Boolean)
      .join("");

    const courseCode = ctx?.courseCode || "";
    const reviews = Array.isArray(data.reviews) ? [...data.reviews] : [];
    reviews.sort((a, b) => {
      const am = rmpCourseMatchesReview(courseCode, a.class) ? 1 : 0;
      const bm = rmpCourseMatchesReview(courseCode, b.class) ? 1 : 0;
      return bm - am;
    });
    const courseMatches = reviews.filter((r) => rmpCourseMatchesReview(courseCode, r.class));
    const reviewSectionTitle =
      courseMatches.length && courseCode ? `Recent reviews for ${courseCode}` : "Recent reviews";
    const reviewCards = reviews.length
      ? reviews
          .slice(0, 6)
          .map((r) =>
            renderRmpReviewCard(r, { courseMatch: rmpCourseMatchesReview(courseCode, r.class) })
          )
          .join("")
      : `<p class="ucrd-gpa-muted">No recent reviews in the loaded profile page.</p>`;

    const distHtml = renderRmpDistributionHtml(data.distribution);
    const fallbackNote =
      data.source === "html"
        ? `<p class="ucrd-gpa-muted">Limited data — open the profile for full details.</p>`
        : "";

    return `<div class="ucrd-panel ucrd-panel-rmp" data-ucrd-panel="${UCRD_TAB.RMP}">
      <div class="ucrd-rmp-hero">
        <div class="ucrd-rmp-hero-score">
          <span class="ucrd-rmp-hero-num">${escapeHtml(rating || "—")}</span>
          <span class="ucrd-rmp-hero-of">/5</span>
          <span class="ucrd-rmp-hero-label">Overall quality</span>
        </div>
        <div class="ucrd-rmp-hero-meta">
          <h2 class="ucrd-rmp-prof-name">${escapeHtml(displayName)}</h2>
          ${subline ? `<p class="ucrd-gpa-muted ucrd-rmp-subline">${escapeHtml(subline)}</p>` : ""}
          <p class="ucrd-gpa-muted ucrd-rmp-row-instructor">Row instructor: <strong>${escapeHtml(prof || "—")}</strong></p>
        </div>
      </div>
      ${statPills ? `<div class="ucrd-rmp-stats">${statPills}</div>` : ""}
      ${fallbackNote}
      <div class="ucrd-rmp-body-grid">
        ${distHtml}
        <section class="ucrd-rmp-reviews">
          <h3 class="ucrd-gpa-subhead">${escapeHtml(reviewSectionTitle)}</h3>
          <div class="ucrd-rmp-review-scroll">${reviewCards}</div>
        </section>
      </div>
      <p class="ucrd-gpa-muted ucrd-rmp-foot"><a class="ucrd-ext-link" href="${escapeHtml(profileUrl)}" target="_blank" rel="noreferrer">View full profile on RateMyProfessors</a></p>
    </div>`;
  }

  function renderSheetPanelHtml(ctx, st) {
    const sheetLink = UCRD_GRADES_SHEET;
    if (st.status === "loading") {
      return `<div class="ucrd-panel ucrd-panel-sheet" data-ucrd-panel="${UCRD_TAB.DIFF}"><p class="ucrd-gpa-muted ucrd-gpa-loading">Loading difficulty database…</p></div>`;
    }
    if (st.status === "error") {
      return `<div class="ucrd-panel ucrd-panel-sheet" data-ucrd-panel="${UCRD_TAB.DIFF}"><h2 class="ucrd-gpa-headline">Difficulty Database</h2><p class="ucrd-gpa-error">${escapeHtml(
        st.message || "Could not load sheet."
      )}</p><p class="ucrd-gpa-muted"><a class="ucrd-ext-link" href="${escapeHtml(
        sheetLink
      )}" target="_blank" rel="noreferrer">Open Google Sheet</a></p></div>`;
    }
    const data = st.data || {};
    if (!data.found) {
      return `<div class="ucrd-panel ucrd-panel-sheet" data-ucrd-panel="${UCRD_TAB.DIFF}"><h2 class="ucrd-gpa-headline">Difficulty Database</h2><p class="ucrd-gpa-muted">No rows for <strong>${escapeHtml(
        ctx?.courseCode || "—"
      )}</strong> in the sheet.</p><p class="ucrd-gpa-muted"><a class="ucrd-ext-link" href="${escapeHtml(
        sheetLink
      )}" target="_blank" rel="noreferrer">Open Google Sheet</a></p></div>`;
    }

    const comments = Array.isArray(data.comments) ? data.comments : [];
    let disc = "";
    if (data.showGeneralDisclaimer && data.classDisplay) {
      disc = `<p class="ucrd-sheet-disclaimer">Showing general comments for ${escapeHtml(
        String(data.classDisplay)
      )}.</p>`;
    }
    const cards = comments.length
      ? comments.map((t) => `<div class="ucrd-sheet-card">${escapeHtml(String(t))}</div>`).join("")
      : `<p class="ucrd-gpa-muted">No written comments for this class.</p>`;

    return `<div class="ucrd-panel ucrd-panel-sheet" data-ucrd-panel="${UCRD_TAB.DIFF}">
      <h2 class="ucrd-gpa-headline">Average difficulty: ${escapeHtml(String(data.difficulty ?? "—"))}</h2>
      <p class="ucrd-gpa-muted">Course: <strong>${escapeHtml(ctx?.courseCode || "—")}</strong></p>
      ${disc}
      <div class="ucrd-sheet-scroll">${cards}</div>
      <p class="ucrd-gpa-muted ucrd-sheet-foot"><a class="ucrd-ext-link" href="${escapeHtml(
        sheetLink
      )}" target="_blank" rel="noreferrer">Open Google Sheet</a></p>
    </div>`;
  }

  function renderAiSettingsBarHtml() {
    return `<div class="ucrd-ai-settings" data-ucrd-ai-settings>
      <div class="ucrd-ai-settings-left">
        <span class="ucrd-ai-settings-label">AI Mode:</span>
        <button type="button" class="ucrd-ai-mode-toggle ucrd-ai-toggle-on" data-ucrd-ai-mode-toggle role="switch" aria-checked="true" aria-label="AI mode">
          <span class="ucrd-ai-toggle-oncap" aria-hidden="true">ON</span>
          <span class="ucrd-ai-toggle-offcap" aria-hidden="true">OFF</span>
          <span class="ucrd-ai-toggle-knob" aria-hidden="true"></span>
        </button>
      </div>
      <div class="ucrd-ai-settings-right">
        <label class="ucrd-ai-settings-label ucrd-ai-key-label" for="ucrd-gemini-api-key-field">Enter Gemini API Key:</label>
        <input type="password" id="ucrd-gemini-api-key-field" class="ucrd-ai-api-input" data-ucrd-gemini-api-key autocomplete="off" spellcheck="false" placeholder="Paste Gemini API key" />
      </div>
    </div>`;
  }

  function renderAiPanelHtml(ctx, st) {
    const bar = renderAiSettingsBarHtml();
    if (st.status === "loading") {
      return `<div class="ucrd-panel ucrd-panel-ai" data-ucrd-panel="${UCRD_TAB.AI}">${bar}<p class="ucrd-gpa-muted ucrd-gpa-loading">Loading AI summary…</p></div>`;
    }
    if (st.status === "disabled") {
      return `<div class="ucrd-panel ucrd-panel-ai" data-ucrd-panel="${UCRD_TAB.AI}">${bar}<h2 class="ucrd-gpa-headline">AI analysis</h2><p class="ucrd-gpa-muted">${escapeHtml(
        st.message || "AI Mode is off."
      )}</p></div>`;
    }
    if (st.status === "unavailable") {
      return `<div class="ucrd-panel ucrd-panel-ai" data-ucrd-panel="${UCRD_TAB.AI}">${bar}<h2 class="ucrd-gpa-headline">AI analysis</h2><p class="ucrd-gpa-muted">${escapeHtml(
        st.message || "Set geminiApiKey in extension storage to enable."
      )}</p></div>`;
    }
    if (st.status === "error") {
      return `<div class="ucrd-panel ucrd-panel-ai" data-ucrd-panel="${UCRD_TAB.AI}">${bar}<h2 class="ucrd-gpa-headline">AI analysis</h2><p class="ucrd-gpa-error">${escapeHtml(
        st.message || "Could not load summary."
      )}</p></div>`;
    }

    const d = st.data || {};
    const diff = d.overallDifficulty;
    let pill = "—";
    let pillStyle = "";
    if (diff != null && Number.isFinite(Number(diff))) {
      const clamped = Math.max(1, Math.min(10, Math.round(Number(diff))));
      pill = `${clamped} / 10`;
      const hue = 120 - (clamped - 1) * (120 / 9);
      pillStyle = ` style="background:hsl(${hue},85%,44%);border:1px solid hsl(${hue},90%,30%);color:#0b1220;font-weight:800;padding:0.15rem 0.45rem;border-radius:999px;display:inline-block;"`;
    }
    const sent = String(d.sentiment ?? "").trim() || "—";
    const tips = Array.isArray(d.tips) ? d.tips : [];
    const mis = Array.isArray(d.mistakes) ? d.mistakes : [];
    const tipLis = tips
      .slice(0, 3)
      .map((t) => `<li>${escapeHtml(String(t))}</li>`)
      .join("");
    const misLis = mis
      .slice(0, 3)
      .map((t) => `<li>${escapeHtml(String(t))}</li>`)
      .join("");

    return `<div class="ucrd-panel ucrd-panel-ai" data-ucrd-panel="${UCRD_TAB.AI}">
      ${bar}
      <div class="ucrd-ai-top"><span class="ucrd-ai-title">Overall difficulty</span><span class="ucrd-ai-pill"${pillStyle}>${escapeHtml(
        pill
      )}</span></div>
      <h3 class="ucrd-gpa-subhead" id="ucrd-ai-sent">Sentiment</h3>
      <p class="ucrd-ai-body">${escapeHtml(sent)}</p>
      <h3 class="ucrd-gpa-subhead">Tips</h3>
      <ul class="ucrd-ai-list">${tipLis || `<li class="ucrd-gpa-muted">—</li>`}</ul>
      <h3 class="ucrd-gpa-subhead">Common mistakes</h3>
      <ul class="ucrd-ai-list">${misLis || `<li class="ucrd-gpa-muted">—</li>`}</ul>
    </div>`;
  }

  function kickoffAiPanelLoads(ctx) {
    if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
    replaceDataPanel(UCRD_TAB.AI, renderAiPanelHtml(ctx, { status: "loading" }));
    loadGeminiSources(ctx).then(({ profKey, sources }) => {
      if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
      try {
        chrome.runtime.sendMessage(
          {
            type: "FETCH_GEMINI_SUMMARY",
            courseCode: ctx.courseCode,
            professorKey: profKey,
            sources,
          },
          (aiResp) => {
            if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
            if (chrome.runtime.lastError) {
              replaceDataPanel(
                UCRD_TAB.AI,
                renderAiPanelHtml(ctx, {
                  status: "error",
                  message: chrome.runtime.lastError.message,
                })
              );
              return;
            }
            if (!aiResp || !aiResp.ok) {
              const msg = aiResp?.error || "AI summary unavailable.";
              const short = String(msg).toLowerCase();
              if (short.includes("api key") || short.includes("geminiapikey")) {
                replaceDataPanel(UCRD_TAB.AI, renderAiPanelHtml(ctx, { status: "unavailable", message: msg }));
              } else {
                replaceDataPanel(UCRD_TAB.AI, renderAiPanelHtml(ctx, { status: "error", message: msg }));
              }
              return;
            }
            replaceDataPanel(UCRD_TAB.AI, renderAiPanelHtml(ctx, { status: "ok", data: aiResp.data }));
          }
        );
      } catch (e) {
        replaceDataPanel(UCRD_TAB.AI, renderAiPanelHtml(ctx, { status: "error", message: e?.message || String(e) }));
      }
    });
  }

  function kickoffSidePanelLoads(ctx) {
    if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;

    const profList = Array.isArray(ctx?.professorNames)
      ? ctx.professorNames.filter((p) => String(p || "").trim())
      : [];
    const sheetProf =
      String(ctx?.sheetProfessorQuery ?? "").trim() ||
      (ctx?.primaryInstructorLabel && ctx.primaryInstructorLabel !== "—" ? ctx.primaryInstructorLabel : "") ||
      (profList.length ? profList[0] : "");

    const rmpProf =
      ctx?.primaryInstructorLabel && ctx.primaryInstructorLabel !== "—"
        ? ctx.primaryInstructorLabel
        : profList[0] || "";

    if (!rmpProf) {
      replaceDataPanel(UCRD_TAB.RMP, renderRmpPanelHtml(ctx, { status: "noprof" }));
    } else {
      try {
        chrome.runtime.sendMessage({ type: "FETCH_RMP", profName: rmpProf }, (resp) => {
          if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
          const le = chrome.runtime.lastError;
          if (le || !resp || !resp.ok) {
            replaceDataPanel(
              UCRD_TAB.RMP,
              renderRmpPanelHtml(ctx, {
                status: "error",
                message: le?.message || resp?.error || "Could not load RMP.",
              })
            );
            return;
          }
          replaceDataPanel(UCRD_TAB.RMP, renderRmpPanelHtml(ctx, { data: resp.data }));
        });
      } catch (e) {
        replaceDataPanel(
          UCRD_TAB.RMP,
          renderRmpPanelHtml(ctx, { status: "error", message: e?.message || String(e) })
        );
      }
    }

    try {
      chrome.runtime.sendMessage(
        { type: "FETCH_SHEET_GRADES", courseCode: ctx.courseCode, professorName: sheetProf },
        (resp) => {
          if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
          if (chrome.runtime.lastError) {
            replaceDataPanel(
              UCRD_TAB.DIFF,
              renderSheetPanelHtml(ctx, { status: "error", message: chrome.runtime.lastError.message })
            );
            return;
          }
          if (!resp || !resp.ok) {
            replaceDataPanel(
              UCRD_TAB.DIFF,
              renderSheetPanelHtml(ctx, { status: "error", message: resp?.error || "Sheet request failed" })
            );
            return;
          }
          replaceDataPanel(UCRD_TAB.DIFF, renderSheetPanelHtml(ctx, { status: "ok", data: resp.data }));
        }
      );
    } catch (e) {
      replaceDataPanel(
        UCRD_TAB.DIFF,
        renderSheetPanelHtml(ctx, { status: "error", message: e?.message || String(e) })
      );
    }

    try {
      chrome.storage.local.get(["geminiAiEnabled"], (r) => {
        if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
        if (chrome.runtime.lastError) {
          kickoffAiPanelLoads(ctx);
          return;
        }
        if (r.geminiAiEnabled === false) {
          replaceDataPanel(
            UCRD_TAB.AI,
            renderAiPanelHtml(ctx, {
              status: "disabled",
              message: "AI Mode is off. Turn AI Mode on above to generate summaries.",
            })
          );
          return;
        }
        kickoffAiPanelLoads(ctx);
      });
    } catch {
      kickoffAiPanelLoads(ctx);
    }
  }

  function buildDeliveryScoresHTML() {
    return `<div class="ucrd-delivery-scores">
    <a href="#" class="ucrd-data-line ucrd-delivery-num" data-ucrd-tab="${UCRD_TAB.GPA}" data-ucrd-line="Avg GPA" title="Avg GPA">—</a>
    <span class="ucrd-delivery-sep" aria-hidden="true">·</span>
    <a href="#" class="ucrd-data-line ucrd-delivery-num" data-ucrd-tab="${UCRD_TAB.RMP}" data-ucrd-line="Prof rating" title="RateMyProfessors rating">—</a>
  </div>`;
  }

  function syncDeliveryScoreLines(stackEl) {
    stackEl.querySelectorAll(`a[data-ucrd-tab="${UCRD_TAB.DIFF}"], a[data-ucrd-tab="${UCRD_TAB.AI}"]`).forEach((el) =>
      el.remove()
    );
    const scores = stackEl.querySelector(".ucrd-delivery-scores");
    if (!scores) {
      stackEl.innerHTML = buildDeliveryScoresHTML();
      return;
    }
    stackEl.querySelector(".ucrd-data-stack")?.remove();
    for (const { tab, label, title } of [
      { tab: UCRD_TAB.GPA, label: "Avg GPA", title: "Avg GPA" },
      { tab: UCRD_TAB.RMP, label: "Prof rating", title: "RateMyProfessors rating" },
    ]) {
      if (scores.querySelector(`a[data-ucrd-tab="${tab}"]`)) continue;
      const a = document.createElement("a");
      a.href = "#";
      a.className = "ucrd-data-line ucrd-delivery-num";
      a.dataset.ucrdTab = tab;
      a.dataset.ucrdLine = label;
      a.title = title;
      a.textContent = "—";
      scores.appendChild(a);
    }
    if (!scores.querySelector(".ucrd-delivery-sep")) {
      const sep = document.createElement("span");
      sep.className = "ucrd-delivery-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "·";
      const rmp = scores.querySelector(`a[data-ucrd-tab="${UCRD_TAB.RMP}"]`);
      if (rmp) scores.insertBefore(sep, rmp);
      else scores.appendChild(sep);
    }
  }

  function getRowContext(anchorEl) {
    const tr = anchorEl?.closest?.("tr");
    const table = tr?.closest?.("table");
    if (!tr || !table) return null;
    const headerRow = findHeaderRow(table);
    if (!headerRow) return null;
    const headerTexts = Array.from(headerRow.cells).map((c) => norm(c.textContent));

    const subjIdx = findColIndex(headerTexts, (t) => t === "subject" || /^subj/.test(t));
    const courseNumIdx = findColIndex(
      headerTexts,
      (t) => t.includes("course") && (t.includes("number") || t.includes("n") || t.includes("num"))
    );
    const titleIdx = findColIndex(headerTexts, (t) => t.includes("title"));
    const instIdx = findColIndex(headerTexts, (t) => t.includes("instructor") || t.includes("instruct"));

    const cellText = (idx) => {
      if (idx < 0 || idx >= tr.cells.length) return "";
      return (tr.cells[idx].textContent || "").replace(/\s+/g, " ").trim();
    };

    /** Instructor column: use innerText so <br> becomes newlines (textContent flattens everyone into one RMP query). */
    const instructorCellText = (idx) => {
      if (idx < 0 || idx >= tr.cells.length) return "";
      const cell = tr.cells[idx];
      return String(cell.innerText || cell.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .trim();
    };

    const subject = cellText(subjIdx);
    const courseNum = cellText(courseNumIdx);
    const title = cellText(titleIdx);
    const instructorRaw = instructorCellText(instIdx);
    const { primaryInstructorLabel, professorNames, sheetProfessorQuery } =
      parseInstructorsFromCell(instructorRaw);

    const courseCode = [subject, courseNum].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return {
      courseCode: courseCode || "—",
      title: title || "—",
      instructorRaw,
      primaryInstructorLabel,
      professorNames,
      sheetProfessorQuery,
    };
  }

  function gradeBarColorClass(i, n) {
    const t = n <= 1 ? 0 : i / (n - 1);
    if (t < 0.28) return "ucrd-bar-a";
    if (t < 0.5) return "ucrd-bar-b";
    if (t < 0.72) return "ucrd-bar-c";
    if (t < 0.88) return "ucrd-bar-d";
    return "ucrd-bar-f";
  }

  /** Mirrors the service worker’s matching so row instructors line up with API names. */
  function namesLikelyMatch(apiName, targets) {
    const api = norm(apiName);
    if (!api) return false;
    const apiParts = api.split(/\s+/).filter(Boolean);
    const apiLast = apiParts[apiParts.length - 1] || "";
    for (const t of targets || []) {
      const tn = norm(t);
      if (!tn) continue;
      if (api === tn) return true;
      if (api.includes(tn) || tn.includes(api)) return true;
      const tParts = tn.split(/\s+/).filter(Boolean);
      const tLast = tParts[tParts.length - 1] || "";
      if (apiLast && tLast && apiLast === tLast && tLast.length >= 2) {
        const tFirst = tParts[0] || "";
        const apiFirst = apiParts[0] || "";
        if (tFirst.length <= 1 || apiFirst.length <= 1) return true;
        if (apiFirst[0] === tFirst[0]) return true;
      }
    }
    return false;
  }

  function instructorRowHighlightClass(name, primary) {
    if (!primary || primary === "—") return "";
    return namesLikelyMatch(name, [primary]) ? "ucrd-inst-highlight" : "";
  }

  function renderInstructorAveragesListLive(list, primaryName, rowInstructorNames) {
    if (!list?.length) {
      return `<p class="ucrd-gpa-muted">No instructor-specific term averages available.</p>`;
    }
    const team = (rowInstructorNames || []).filter((s) => s && s !== "—");
    const items = list
      .map((x) => {
        const mark = instructorRowHighlightClass(x.name, primaryName);
        const teachesRow = team.some((t) => namesLikelyMatch(x.name, [t]));
        const star = teachesRow
          ? `<span class="ucrd-inst-star" title="Listed on your course row">★</span> `
          : "";
        const g = x.averageGpa != null ? fmtGpa(x.averageGpa) : "—";
        const gr = x.graded != null ? Number(x.graded).toLocaleString() : "—";
        return `<li class="${mark}">${star}<span class="ucrd-gpa-inst-name">${escapeHtml(x.name || "—")}</span><span class="ucrd-gpa-muted">${escapeHtml(
          g
        )} GPA · ${escapeHtml(gr)} graded</span></li>`;
      })
      .join("");
    return `<ul class="ucrd-gpa-inst-list">${items}</ul>`;
  }

  function renderGpaPanel(ctx, gpaState) {
    const st = gpaState && gpaState.status ? gpaState : { status: "loading" };

    if (st.status === "loading") {
      return `
      <div class="ucrd-panel ucrd-panel-gpa" data-ucrd-panel="${UCRD_TAB.GPA}">
        <p class="ucrd-gpa-muted ucrd-gpa-loading">Loading grade data…</p>
      </div>`;
    }

    if (st.status === "error") {
      return `
      <div class="ucrd-panel ucrd-panel-gpa" data-ucrd-panel="${UCRD_TAB.GPA}">
        <h2 class="ucrd-gpa-headline">Average GPA</h2>
        <p class="ucrd-gpa-error">${escapeHtml(st.message || "Could not load grades.")}</p>
        <p class="ucrd-gpa-muted">Course: ${escapeHtml(ctx?.courseCode || "—")}</p>
      </div>`;
    }

    const payload = st.payload;
    const course = payload.course || {};
    const titleApi = course.title || ctx?.title || "—";
    const subtitle =
      titleApi !== "—"
        ? String(titleApi).toUpperCase()
        : String(ctx?.title && ctx.title !== "—" ? ctx.title : titleApi).toUpperCase();

    const dashHtml = renderMcgDashboardSection(
      payload,
      ctx,
      ucrdMcgInstructor || "__default__",
      ucrdMcgTermKey
    );

    return `
      <div class="ucrd-panel ucrd-panel-gpa" data-ucrd-panel="${UCRD_TAB.GPA}">
        <h2 class="ucrd-gpa-headline">${escapeHtml(ctx?.courseCode || "Course")}</h2>
        <p class="ucrd-gpa-muted ucrd-gpa-course">${escapeHtml(subtitle)}</p>
        <div data-ucrd-mcg-mount>${dashHtml}</div>
      </div>
    `;
  }

  function buildModalPanelsHTML(ctx, gpaState) {
    return [
      renderGpaPanel(ctx, gpaState),
      renderRmpPanelHtml(ctx, { status: "loading" }),
      renderSheetPanelHtml(ctx, { status: "loading" }),
      renderAiPanelHtml(ctx, { status: "loading" }),
    ].join("");
  }

  function setActiveTab(tab) {
    if (!ucrdModalEl) return;
    const allowed = new Set(Object.values(UCRD_TAB));
    const t = allowed.has(tab) ? tab : UCRD_TAB.GPA;
    ucrdModalEl.dataset.ucrdActiveTab = t;
    ucrdModalEl.querySelectorAll("[data-ucrd-tab-btn]").forEach((btn) => {
      const on = btn.getAttribute("data-ucrd-tab-btn") === t;
      btn.classList.toggle("ucrd-tab-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    ucrdModalEl.querySelectorAll("[data-ucrd-panel]").forEach((panel) => {
      const on = panel.getAttribute("data-ucrd-panel") === t;
      panel.hidden = !on;
    });
  }

  function closeUcrdModal() {
    if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
    ucrdModalLoadCtx = null;
    ucrdGpaPanelPayload = null;
    ucrdMcgInstructor = "";
    ucrdMcgTermKey = "";
    hideGradeChartTooltip();
    ucrdModalEl.setAttribute("hidden", "");
    document.documentElement.classList.remove("ucrd-modal-open");
    if (document.body) document.body.classList.remove("ucrd-modal-open");
    if (ucrdModalEscapeHandler) {
      document.removeEventListener("keydown", ucrdModalEscapeHandler, true);
      ucrdModalEscapeHandler = null;
    }
  }

  function openUcrdModal(tab, anchorEl) {
    const ctx = getRowContext(anchorEl) || {};
    ucrdModalLoadCtx = ctx;
    ucrdGpaPanelPayload = null;
    ucrdMcgInstructor = "";
    ucrdMcgTermKey = "";
    if (!ucrdModalEl) {
      ucrdModalEl = document.createElement("div");
      ucrdModalEl.className = "ucrd-modal-root";
      ucrdModalEl.setAttribute("hidden", "");
      ucrdModalEl.innerHTML = `
        <div class="ucrd-modal-overlay" data-ucrd-close="overlay"></div>
        <div class="ucrd-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="ucrd-modal-title">
          <h2 class="ucrd-sr-only" id="ucrd-modal-title">Class data</h2>
          <div class="ucrd-modal-header">
            <div class="ucrd-modal-tabs" role="tablist" aria-label="Data sources">
              <button type="button" class="ucrd-tab-pill" data-ucrd-tab-btn="${UCRD_TAB.GPA}" role="tab" id="ucrd-tab-gpa">Avg GPA</button>
              <button type="button" class="ucrd-tab-pill" data-ucrd-tab-btn="${UCRD_TAB.RMP}" role="tab">RateMyProfessor</button>
              <button type="button" class="ucrd-tab-pill" data-ucrd-tab-btn="${UCRD_TAB.DIFF}" role="tab">Diff. Database</button>
              <button type="button" class="ucrd-tab-pill" data-ucrd-tab-btn="${UCRD_TAB.AI}" role="tab">AI Analysis</button>
            </div>
            <button type="button" class="ucrd-modal-x" data-ucrd-close="x" aria-label="Close">×</button>
          </div>
          <div class="ucrd-modal-scroll">
            <div class="ucrd-modal-panels"></div>
          </div>
        </div>
      `;
      (document.body || document.documentElement).appendChild(ucrdModalEl);

      ucrdModalEl.addEventListener("change", (e) => {
        const sel = e.target;
        if (sel instanceof HTMLSelectElement && sel.matches("[data-ucrd-mcg-instructor], [data-ucrd-mcg-term]")) {
          handleMcgSelectChange(sel);
        }
      });

      ucrdModalEl.addEventListener("click", (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const aiToggle = t.closest("[data-ucrd-ai-mode-toggle]");
        if (aiToggle && ucrdModalEl.contains(aiToggle)) {
          e.preventDefault();
          try {
            chrome.storage.local.get(["geminiAiEnabled"], (r) => {
              if (chrome.runtime.lastError || !ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
              const wasOn = r.geminiAiEnabled !== false;
              const nowOn = !wasOn;
              chrome.storage.local.set({ geminiAiEnabled: nowOn }, () => {
                if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
                const panel = ucrdModalEl.querySelector(`[data-ucrd-panel="${UCRD_TAB.AI}"]`);
                syncAiGeminiSettingsBar(panel);
                if (!ucrdModalLoadCtx) return;
                if (nowOn) kickoffAiPanelLoads(ucrdModalLoadCtx);
                else {
                  replaceDataPanel(
                    UCRD_TAB.AI,
                    renderAiPanelHtml(ucrdModalLoadCtx, {
                      status: "disabled",
                      message: "AI Mode is off. Turn AI Mode on above to generate summaries.",
                    })
                  );
                }
              });
            });
          } catch {
            /* ignore */
          }
          return;
        }
        const closeKind = t.closest("[data-ucrd-close]")?.getAttribute("data-ucrd-close");
        if (closeKind === "overlay" || closeKind === "x") closeUcrdModal();
      });

      ucrdModalEl.addEventListener(
        "focusout",
        (e) => {
          const t = e.target;
          if (!(t instanceof Element)) return;
          const inp = t.closest("[data-ucrd-gemini-api-key]");
          if (!inp || !ucrdModalEl.contains(inp)) return;
          const v = String(inp.value || "").trim();
          if (!v) return;
          try {
            chrome.storage.local.set({ geminiApiKey: v }, () => {
              inp.value = "";
              const panel = inp.closest(`[data-ucrd-panel="${UCRD_TAB.AI}"]`);
              syncAiGeminiSettingsBar(panel);
              chrome.storage.local.get(["geminiAiEnabled"], (r2) => {
                if (r2.geminiAiEnabled !== false && ucrdModalLoadCtx) kickoffAiPanelLoads(ucrdModalLoadCtx);
              });
            });
          } catch {
            /* ignore */
          }
        },
        true
      );

      ucrdModalEl.querySelectorAll("[data-ucrd-tab-btn]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-ucrd-tab-btn");
          if (key) setActiveTab(key);
        });
      });

      const scrollHost = ucrdModalEl.querySelector(".ucrd-modal-scroll");
      if (scrollHost && scrollHost.dataset.ucrdTipScroll !== "1") {
        scrollHost.dataset.ucrdTipScroll = "1";
        scrollHost.addEventListener("scroll", hideGradeChartTooltip, { passive: true });
      }
    }

    const panels = ucrdModalEl.querySelector(".ucrd-modal-panels");
    if (panels) panels.innerHTML = buildModalPanelsHTML(ctx, { status: "loading" });
    const aiPanel0 = panels?.querySelector(`[data-ucrd-panel="${UCRD_TAB.AI}"]`);
    if (aiPanel0) syncAiGeminiSettingsBar(aiPanel0);

    ucrdModalEl.removeAttribute("hidden");
    document.documentElement.classList.add("ucrd-modal-open");
    if (document.body) document.body.classList.add("ucrd-modal-open");

    setActiveTab(tab);

    kickoffSidePanelLoads(ctx);

    const titleEl = ucrdModalEl.querySelector("#ucrd-modal-title");
    if (titleEl) {
      const bits = [ctx.courseCode].filter(Boolean);
      titleEl.textContent = bits.length ? `Class data: ${bits[0]}` : "Class data";
    }

    requestMyClassGrades(ctx, (res) => {
      if (!ucrdModalEl || ucrdModalEl.hasAttribute("hidden")) return;
      if (res.ok) ucrdGpaPanelPayload = res;
      else ucrdGpaPanelPayload = null;
      const html = res.ok
        ? renderGpaPanel(ctx, { status: "ok", payload: res })
        : renderGpaPanel(ctx, { status: "error", message: res.error || "Could not load grade data." });
      replaceGpaPanel(html);
      const dash = ucrdModalEl.querySelector("[data-ucrd-mcg-dashboard]");
      if (dash) {
        ucrdMcgInstructor = dash.getAttribute("data-ucrd-mcg-instructor") || "";
        ucrdMcgTermKey = dash.getAttribute("data-ucrd-mcg-term") || "";
      }
      setActiveTab(ucrdModalEl.dataset.ucrdActiveTab || tab);
    });

    if (!ucrdModalEscapeHandler) {
      ucrdModalEscapeHandler = (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeUcrdModal();
        }
      };
      document.addEventListener("keydown", ucrdModalEscapeHandler, true);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ensureDeliveryEnhancement(table, headerRow, deliveryIdx) {
    for (const tr of Array.from(table.rows)) {
      if (tr === headerRow) continue;
      const parentTag = tr.parentElement?.tagName;
      if (parentTag === "THEAD" || parentTag === "TFOOT") continue;
      if (!tr.cells.length) continue;

      const isHeaderLike =
        tr.cells[0].tagName === "TH" &&
        !table.tHead &&
        tr.rowIndex === 0 &&
        Array.from(tr.cells).every((c) => c.tagName === "TH");
      if (isHeaderLike) continue;

      const td = tr.cells[deliveryIdx];
      if (!td || td.tagName !== "TD") continue;

      td.classList.add(DELIVERY_ENHANCED_CLASS);
      let stack = td.querySelector(`.${DELIVERY_STACK_CLASS}`);
      if (!stack) {
        stack = document.createElement("div");
        stack.className = DELIVERY_STACK_CLASS;
        stack.innerHTML = buildDeliveryScoresHTML();
        td.appendChild(stack);
      } else {
        syncDeliveryScoreLines(stack);
      }
    }
  }

  function wireDeliveryScoreInteractions(table) {
    table.querySelectorAll(`td.${DELIVERY_ENHANCED_CLASS} a.ucrd-data-line`).forEach((a) => {
      if (a.dataset.ucrdBound === "1") return;
      a.dataset.ucrdBound = "1";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tab = a.getAttribute("data-ucrd-tab") || UCRD_TAB.GPA;
        openUcrdModal(tab, a);
      });
    });
  }

  /**
   * Inline Avg GPA: prefer weighted GPA for a row instructor when present in grade data,
   * else course-wide average from the API.
   */
  function gpaDisplayForRowFromMyClassRes(res, ctx) {
    if (!res || !res.ok) return "—";
    if (
      res.historyFiltered &&
      res.sectionWeightedGpa != null &&
      Number(res.sectionWeightedStudents) > 0
    ) {
      return fmtGpa(res.sectionWeightedGpa);
    }
    const list = Array.isArray(res.instructorAverages) ? res.instructorAverages : [];
    const primaryRaw = String(ctx?.primaryInstructorLabel ?? "").trim();
    const primary = primaryRaw && primaryRaw !== "—" ? primaryRaw : "";
    const team = Array.isArray(ctx?.professorNames)
      ? ctx.professorNames.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];

    for (const row of list) {
      if (row?.averageGpa == null || !Number.isFinite(Number(row.averageGpa))) continue;
      if (primary && namesLikelyMatch(row.name, [primary])) return fmtGpa(row.averageGpa);
    }
    for (const row of list) {
      if (row?.averageGpa == null || !Number.isFinite(Number(row.averageGpa))) continue;
      if (team.length && namesLikelyMatch(row.name, team)) return fmtGpa(row.averageGpa);
    }
    if (res.course?.averageGpa != null) {
      const n = Number(res.course.averageGpa);
      if (!Number.isNaN(n)) return fmtGpa(n);
    }
    return "—";
  }

  function setDeliveryNumLine(anchor, display, min, max, decimals, goodHigh) {
    if (!anchor) return;
    if (display === "—" || display == null) {
      anchor.textContent = "—";
      return;
    }
    const n = Number(display);
    if (!Number.isFinite(n)) {
      anchor.textContent = String(display);
      return;
    }
    anchor.textContent = "";
    const strong = document.createElement("span");
    strong.className = "ucrd-inline-num";
    if (goodHigh) styleValueGoodHigh(strong, n, min, max, decimals);
    else styleValueGoodLow(strong, n, min, max, decimals);
    anchor.appendChild(strong);
  }

  function updateGpaDataLine(td, displayGpa) {
    const a = td.querySelector(`a.ucrd-data-line[data-ucrd-tab="${UCRD_TAB.GPA}"]`);
    setDeliveryNumLine(a, displayGpa, 2.0, 4.0, 2, true);
  }

  function updateRmpDataLine(td, ratingDisplay) {
    const a = td.querySelector(`a.ucrd-data-line[data-ucrd-tab="${UCRD_TAB.RMP}"]`);
    setDeliveryNumLine(a, ratingDisplay, 1.0, 5.0, 1, true);
  }

  function prefetchInlineSummariesForDeliveryCells(table) {
    table.querySelectorAll(`td.${DELIVERY_ENHANCED_CLASS}`).forEach((td) => {
      if (td.dataset.ucrdPrefetch === "1") return;
      const link = td.querySelector("a.ucrd-data-line");
      if (!link) return;
      const ctx = getRowContext(link);
      if (!ctx?.courseCode || ctx.courseCode === "—") return;
      td.dataset.ucrdPrefetch = "1";

      requestMyClassGrades(ctx, (res) => {
        if (!td.isConnected) return;
        updateGpaDataLine(td, gpaDisplayForRowFromMyClassRes(res, ctx));
      });

      const rmpProf =
        ctx.primaryInstructorLabel && ctx.primaryInstructorLabel !== "—"
          ? ctx.primaryInstructorLabel
          : (ctx.professorNames && ctx.professorNames[0]) || "";
      if (rmpProf) {
        try {
          chrome.runtime.sendMessage({ type: "FETCH_RMP", profName: rmpProf }, (resp) => {
            if (!td.isConnected) return;
            if (!resp || !resp.ok || !resp.data?.found) {
              updateRmpDataLine(td, "—");
              return;
            }
            const r = formatRatingMaybe(resp.data.avgRating);
            updateRmpDataLine(td, r || "—");
          });
        } catch {
          updateRmpDataLine(td, "—");
        }
      }
    });
  }

  function forceTableRelayout(table) {
    if (!table?.isConnected) return;
    const root = findResultsContainer();
    const read = (el) => {
      if (!el?.isConnected) return;
      void el.offsetWidth;
      void el.offsetHeight;
      void el.getBoundingClientRect();
    };
    read(table);
    read(root);
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
    if (typeof Event === "function") {
      try {
        window.dispatchEvent(new Event("scroll"));
      } catch {
        /* ignore */
      }
    }
    requestAnimationFrame(() => {
      read(table);
      read(root);
      window.dispatchEvent(new Event("resize"));
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        read(table);
        window.dispatchEvent(new Event("resize"));
      });
    });
  }

  function disconnectTableObserver() {
    if (tableObserver) {
      tableObserver.disconnect();
      tableObserver = null;
    }
    observedTable = null;
  }

  function attachTableObserver(table) {
    if (observedTable === table && tableObserver) return;
    disconnectTableObserver();
    observedTable = table;
    const target = table.tBodies[0] || table;
    tableObserver = new MutationObserver(() => scheduleEnhance());
    tableObserver.observe(target, { childList: true, subtree: true });
  }

  function enhance() {
    const hit = findResultsTable();
    if (!hit) return;

    const { table, headerRow } = hit;
    removeLegacyDataColumn(table, headerRow);

    const headerTexts = Array.from(headerRow.cells).map((c) => norm(c.textContent));
    const deliveryIdx = findDeliveryColumnIndex(headerTexts);
    if (deliveryIdx < 0) return;

    ensureDeliveryEnhancement(table, headerRow, deliveryIdx);
    wireDeliveryScoreInteractions(table);
    prefetchInlineSummariesForDeliveryCells(table);

    attachTableObserver(table);
    forceTableRelayout(table);
  }

  function scheduleEnhance() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        enhance();
      } catch {
        /* ignore */
      }
    }, 50);
  }

  function waitForInitialContextThenStart() {
    const maxWaitMs = 25000;
    const start = Date.now();

    const considerStart = () => {
      const hit = findResultsTable();
      const root = findResultsContainer();
      if (!hit || !hit.table.isConnected) return false;
      if (root && !root.isConnected) return false;
      return true;
    };

    const onMaybeReady = () => {
      if (!considerStart()) return;
      scheduleEnhance();
    };

    const poll = window.setInterval(() => {
      if (considerStart() || Date.now() - start > maxWaitMs) {
        window.clearInterval(poll);
        scheduleEnhance();
      }
    }, 100);

    docObserver = new MutationObserver(() => {
      onMaybeReady();
      scheduleEnhance();
    });
    docObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden"],
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onMaybeReady, { once: true });
    }

    requestAnimationFrame(() => {
      onMaybeReady();
      scheduleEnhance();
    });

    window.setTimeout(() => {
      window.clearInterval(poll);
      scheduleEnhance();
    }, maxWaitMs);
  }

  window.addEventListener("hashchange", scheduleEnhance);
  window.addEventListener("popstate", scheduleEnhance);

  wireGradeChartTooltipsOnce();
  waitForInitialContextThenStart();
})();
