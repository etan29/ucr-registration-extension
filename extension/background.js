/**
 * background.js (MV3 Service Worker)
 *
 * All cross-origin fetching happens here to bypass CORS.
 */

const DEBUG = false;

const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 UCRRegistrationExtension/1.0.0";

const GRADES_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1qiy_Oi8aFiPmL4QSTR3zHe74kmvc6e_159L1mAUUlU0/gviz/tq?tqx=out:csv";

const MYCLASSGRADES_GRAPHQL_URL = "https://api.myclassgrades.com/graphql";

// ---------- Global cache (memory + chrome.storage.local) ----------

const CACHE_STORAGE_PREFIX = "cache:";
const DEFAULT_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
/** Unfiltered MyClassGrades course payload (one entry per course; professors filtered on read). */
const MCG_CANONICAL_CACHE_VERSION = 3;
const MCG_RESPONSE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14d
/** Bump when Difficulty Database parsing / payload shape changes (invalidates stale chrome.storage cache). */
const SHEET_RESULT_CACHE_VERSION = 2;
/** @type {Map<string, { ts: number, ttlMs: number, value: any }>} */
const memoryCache = new Map();

function nowMs() {
  return Date.now();
}

function cacheKey(scope, rawKey) {
  const k = String(rawKey ?? "")
    .trim()
    .replace(/\s+/g, "_");
  return `${String(scope ?? "GEN").toUpperCase()}:${k}`;
}

async function cacheGet(key) {
  const m = memoryCache.get(key);
  if (m && nowMs() - m.ts <= (m.ttlMs ?? DEFAULT_CACHE_TTL_MS)) return m.value;

  const storageKey = `${CACHE_STORAGE_PREFIX}${key}`;
  const stored = await chrome.storage.local.get(storageKey);
  const entry = stored?.[storageKey];
  if (!entry || typeof entry !== "object") return null;
  if (nowMs() - entry.ts > (entry.ttlMs ?? DEFAULT_CACHE_TTL_MS)) return null;

  memoryCache.set(key, entry);
  return entry.value;
}

async function cacheSet(key, value, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const entry = { ts: nowMs(), ttlMs, value };
  memoryCache.set(key, entry);
  const storageKey = `${CACHE_STORAGE_PREFIX}${key}`;
  await chrome.storage.local.set({ [storageKey]: entry });
}

async function cachedFetch(key, fetcher, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const hit = await cacheGet(key);
  if (hit != null) return { ok: true, cached: true, data: hit };

  const data = await fetcher();
  await cacheSet(key, data, ttlMs);
  return { ok: true, cached: false, data };
}

/** Cached raw CSV string — avoids re-downloading the full sheet on every click */
let cachedGradeData = null;

// ---------- Logging ----------

function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

function previewText(text, max = 200) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * @param {string} label
 * @param {string} url
 * @param {Response} res
 * @param {string} [bodyText] full body when logging failure
 */
function logFetchOk(label, url, res, bodyText) {
  debugLog(
    `[UCRX bg] ${label} OK status=${res.status} url=${url} len=${bodyText?.length ?? 0}`
  );
}

function logFetchFail(label, url, res, bodyText) {
  console.error(
    `[UCRX bg] ${label} FAIL status=${res?.status ?? "?"} url=${url} preview=${previewText(bodyText)}`
  );
}

function logFetchError(label, url, err) {
  console.error(`[UCRX bg] ${label} ERROR url=${url}`, err);
}

// ---------- RMP: HTML scrape (__RELAY_STORE__ + regex fallback) ----------

const RMP_CACHE_VERSION = 2;
const RMP_SCHOOL_LEGACY_ID = 1076; // UC Riverside

function buildRmpSearchUrl(profName) {
  const q = encodeURIComponent(String(profName).trim());
  return `https://www.ratemyprofessors.com/search/professors/${RMP_SCHOOL_LEGACY_ID}?q=${q}`;
}

function buildRmpProfileUrl(legacyId) {
  return `https://www.ratemyprofessors.com/professor/${legacyId}`;
}

function normProfName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function profNameMatches(wantName, firstName, lastName) {
  const want = normProfName(wantName);
  const wantParts = want.split(" ").filter(Boolean);
  const wantLast = wantParts.length ? wantParts[wantParts.length - 1] : "";
  const wantFirst = wantParts.length ? wantParts[0] : "";
  const first = normProfName(firstName);
  const last = normProfName(lastName);
  if (!last || !wantLast || last !== wantLast) return false;
  const wantIsInitial = wantFirst.length === 1;
  return (
    !wantFirst ||
    first === wantFirst ||
    (wantIsInitial && first.startsWith(wantFirst))
  );
}

function extractRelayStore(html) {
  const src = String(html ?? "");
  const m = src.match(/window\.__RELAY_STORE__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function collectRelayTeachers(store) {
  const out = [];
  if (!store || typeof store !== "object") return out;
  for (const v of Object.values(store)) {
    if (v && v.__typename === "Teacher" && v.legacyId != null) out.push(v);
  }
  return out;
}

function pickBestTeacherMatch(teachers, profName) {
  const matches = teachers.filter((t) =>
    profNameMatches(profName, t.firstName, t.lastName)
  );
  if (!matches.length) return null;
  matches.sort(
    (a, b) => (Number(b.numRatings ?? 0) || 0) - (Number(a.numRatings ?? 0) || 0)
  );
  return matches[0];
}

function relaySchoolName(store, teacher) {
  const ref = teacher?.school?.__ref;
  if (ref && store?.[ref]?.name) return String(store[ref].name);
  return null;
}

function relayRatingsDistribution(store, teacher) {
  const ref = teacher?.ratingsDistribution?.__ref;
  const d = ref ? store?.[ref] : null;
  if (!d || d.__typename !== "ratingsDistribution") return null;
  return {
    total: d.total ?? null,
    r1: d.r1 ?? 0,
    r2: d.r2 ?? 0,
    r3: d.r3 ?? 0,
    r4: d.r4 ?? 0,
    r5: d.r5 ?? 0,
  };
}

function parseRmpRatingTags(raw) {
  return String(raw ?? "")
    .split("--")
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeRmpTextbookUse(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return "Yes";
  if (n === 0) return "No";
  return "N/A";
}

function normalizeRmpReview(r) {
  if (!r || r.__typename !== "Rating") return null;
  const wouldTakeAgain =
    r.wouldTakeAgain === 1 ? true : r.wouldTakeAgain === 0 ? false : null;
  return {
    class: r.class ?? null,
    date: r.date ?? null,
    quality: r.clarityRating ?? null,
    difficulty: r.difficultyRating ?? null,
    comment: String(r.comment ?? "").trim() || null,
    tags: parseRmpRatingTags(r.ratingTags),
    wouldTakeAgain,
    attendance: r.attendanceMandatory ?? null,
    grade: r.grade ?? null,
    isForCredit: r.isForCredit ?? null,
    textbook: normalizeRmpTextbookUse(r.textbookUse),
  };
}

function collectRelayReviews(store, limit = 8) {
  const reviews = [];
  if (!store || typeof store !== "object") return reviews;
  for (const v of Object.values(store)) {
    const row = normalizeRmpReview(v);
    if (row && (row.comment || row.quality != null)) reviews.push(row);
  }
  reviews.sort((a, b) => {
    const ta = Date.parse(a.date) || 0;
    const tb = Date.parse(b.date) || 0;
    return tb - ta;
  });
  return reviews.slice(0, limit);
}

function teacherMetricsPayload(teacher, store, source) {
  const legacyId = Number(teacher.legacyId);
  const schoolName = relaySchoolName(store, teacher);
  return {
    found: true,
    source,
    legacyId: Number.isFinite(legacyId) ? legacyId : null,
    profileUrl: Number.isFinite(legacyId) ? buildRmpProfileUrl(legacyId) : null,
    firstName: teacher.firstName ?? null,
    lastName: teacher.lastName ?? null,
    department: teacher.department ?? null,
    schoolName,
    avgRating: teacher.avgRating ?? null,
    numRatings: teacher.numRatings ?? null,
    wouldTakeAgainPercent: teacher.wouldTakeAgainPercent ?? null,
    avgDifficulty: teacher.avgDifficulty ?? null,
  };
}

async function fetchRmpHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": UA_BROWSER,
    },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    logFetchFail("RMP HTML", url, res, text);
    const err = new Error(`RMP fetch failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  logFetchOk("RMP HTML", url, res, text);
  return text;
}

/**
 * Parse RMP search HTML for embedded JSON when __RELAY_STORE__ is unavailable.
 */
function parseRmpHtmlMetricsForName(html, profName) {
  const src = String(html ?? "");

  const want = normProfName(profName);
  const wantParts = want.split(" ").filter(Boolean);
  const wantLast = wantParts.length ? wantParts[wantParts.length - 1] : "";
  const wantFirst = wantParts.length ? wantParts[0] : "";

  const candidates = [];
  const nameRe = /"firstName"\s*:\s*"([^"]+)"\s*,\s*"lastName"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = nameRe.exec(src))) {
    const first = normProfName(m[1]);
    const last = normProfName(m[2]);
    if (!last || !wantLast) continue;

    const lastOk = last === wantLast;
    const wantIsInitial = wantFirst.length === 1;
    const firstOk =
      !wantFirst ||
      first === wantFirst ||
      (wantIsInitial && first.startsWith(wantFirst));
    if (!lastOk || !firstOk) continue;

    const idx = m.index;
    const slice = src.slice(Math.max(0, idx - 2000), Math.min(src.length, idx + 8000));

    const tryNumIn = (re) => {
      const mm = slice.match(re);
      if (!mm) return null;
      const n = Number(mm[1]);
      return Number.isFinite(n) ? n : null;
    };

    const avgRating =
      tryNumIn(/["']avgRating["']\s*:\s*([0-9.]+)/) ??
      tryNumIn(/\\"avgRating\\"\s*:\s*([0-9.]+)/) ??
      tryNumIn(/avgRating\\?":\s*([0-9.]+)/);

    const numRatings =
      tryNumIn(/["']numRatings["']\s*:\s*([0-9]+)/) ??
      tryNumIn(/\\"numRatings\\"\s*:\s*([0-9]+)/) ??
      tryNumIn(/numRatings\\?":\s*([0-9]+)/);

    const wouldTakeAgainPercent =
      tryNumIn(/["']wouldTakeAgainPercent["']\s*:\s*([0-9.]+)/) ??
      tryNumIn(/\\"wouldTakeAgainPercent\\"\s*:\s*([0-9.]+)/);

    const hasMetrics =
      avgRating != null || numRatings != null || wouldTakeAgainPercent != null;
    if (!hasMetrics) continue;

    candidates.push({
      first,
      last,
      avgRating,
      numRatings,
      wouldTakeAgainPercent
    });
  }

  if (candidates.length) {
    // Prefer the candidate with the most ratings (more reliable) if present
    candidates.sort((a, b) => (Number(b.numRatings ?? 0) || 0) - (Number(a.numRatings ?? 0) || 0));
    const best = candidates[0];
    return { found: true, ...best };
  }

  return { found: false };
}

async function enrichRmpFromProfilePage(base, legacyId) {
  if (!Number.isFinite(legacyId)) return base;
  const url = buildRmpProfileUrl(legacyId);
  debugLog(`[UCRX bg] RMP profile fetch start url=${url}`);
  let text;
  try {
    text = await fetchRmpHtml(url);
  } catch (e) {
    logFetchError("RMP profile", url, e);
    return base;
  }

  const store = extractRelayStore(text);
  if (!store) return base;

  const teachers = collectRelayTeachers(store);
  const teacher =
    teachers.find((t) => Number(t.legacyId) === legacyId) ||
    pickBestTeacherMatch(teachers, `${base.firstName || ""} ${base.lastName || ""}`.trim());
  if (!teacher) return base;

  const merged = {
    ...base,
    ...teacherMetricsPayload(teacher, store, "relay+profile"),
  };
  const distribution = relayRatingsDistribution(store, teacher);
  if (distribution) merged.distribution = distribution;
  const reviews = collectRelayReviews(store, 8);
  if (reviews.length) merged.reviews = reviews;
  return merged;
}

async function getRmpProfessorData(profName) {
  const url = buildRmpSearchUrl(profName);
  debugLog(`[UCRX bg] RMP search fetch start url=${url}`);

  let text;
  try {
    text = await fetchRmpHtml(url);
  } catch (e) {
    logFetchError("RMP HTML", url, e);
    return { found: false, useSearchFallback: true, error: String(e?.message ?? e) };
  }

  const store = extractRelayStore(text);
  if (store) {
    const teacher = pickBestTeacherMatch(collectRelayTeachers(store), profName);
    if (teacher) {
      const base = teacherMetricsPayload(teacher, store, "relay");
      const distribution = relayRatingsDistribution(store, teacher);
      if (distribution) base.distribution = distribution;
      if (base.legacyId != null) {
        return enrichRmpFromProfilePage(base, base.legacyId);
      }
      return base;
    }
  }

  const parsed = parseRmpHtmlMetricsForName(text, profName);
  if (parsed.found) {
    return {
      found: true,
      source: "html",
      avgRating: parsed.avgRating,
      numRatings: parsed.numRatings,
      wouldTakeAgainPercent: parsed.wouldTakeAgainPercent,
    };
  }

  debugLog(
    `[UCRX bg] RMP: no match for "${profName}" preview=${previewText(text)}`
  );
  return { found: false, useSearchFallback: true };
}

// ---------- Google Sheets CSV ----------

function normCourseKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

async function fetchTextWithDebug(label, url, init) {
  debugLog(`[UCRX bg] ${label} fetch start url=${url}`);
  let res;
  let text;
  try {
    res = await fetch(url, init);
    text = await res.text().catch(() => "");
  } catch (e) {
    logFetchError(label, url, e);
    throw e;
  }

  if (!res.ok) {
    logFetchFail(label, url, res, text);
    const err = new Error(`${label} fetch failed (${res.status})`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  logFetchOk(label, url, res, text);
  return text;
}

/**
 * Minimal CSV parser (quoted fields, commas).
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      cur += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }

    if (ch === "\n") {
      row.push(cur.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }

    cur += ch;
  }

  row.push(cur);
  if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) rows.push(row);
  return rows;
}

function normHeader(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 %]/g, "")
    .trim();
}

/**
 * Load CSV once into memory; subsequent calls reuse cache.
 */
async function getCachedGradeCsv() {
  if (cachedGradeData != null) {
    debugLog(
      `[UCRX bg] Sheet CSV: using cached data len=${cachedGradeData.length}`
    );
    return cachedGradeData;
  }
  const csv = await fetchTextWithDebug("Sheet CSV", GRADES_CSV_URL, {
    method: "GET",
    headers: {
      Accept: "text/csv,*/*",
      "User-Agent": UA_BROWSER
    }
  });
  cachedGradeData = csv;
  return csv;
}

/**
 * Normalize class cell: lowercase, no spaces (matches Column A, e.g. "MATH009A" -> "math009a").
 */
function normalizeClassCell(value) {
  return normCourseKey(value);
}

/**
 * Last name only, normalized for substring search in comments (lowercase, no spaces).
 */
function extractLastNameKey(professorName) {
  const raw = String(professorName ?? "").trim();
  if (!raw) return "";
  const noParen = raw.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  if (noParen.includes(",")) {
    const first = noParen.split(",")[0].trim();
    return normalizeClassCell(first);
  }
  const parts = noParen.split(/\s+/).filter(Boolean);
  return parts.length ? normalizeClassCell(parts[parts.length - 1]) : "";
}

function isLikelyHeaderRow(row) {
  const a = normHeader(String(row[0] ?? ""));
  return a === "class" || (a.includes("class") && row.length >= 2);
}

/**
 * Map sheet columns: Class (A), Average Difficulty (B), Additional Comments (C).
 */
function resolveThreeColumnIndices(headerRow) {
  const labels = (headerRow || []).map(normHeader);
  let idxClass = labels.findIndex((h) => h === "class" || h.endsWith("class"));
  let idxDiff = labels.findIndex(
    (h) =>
      h.includes("difficult") ||
      h.includes("difficulty") ||
      h.includes("average")
  );
  let idxComment = labels.findIndex(
    (h) =>
      h.includes("comment") ||
      h.includes("additional") ||
      h.includes("review") ||
      h.includes("note")
  );
  if (idxClass < 0) idxClass = 0;
  if (idxDiff < 0) idxDiff = 1;
  if (idxComment < 0) idxComment = 2;
  return { idxClass, idxDiff, idxComment };
}

/**
 * When the sheet has explicit Date (and optional per-row Difficulty) columns after Comments,
 * map their indices from the header row.
 * @returns {{ idxDate: number, bodyEnd: number } | null}
 */
function resolveStructuredCommentSlice(headerRow, idxDiff, idxComment) {
  const labels = (headerRow || []).map(normHeader);
  const idxDate = labels.findIndex((h) => h === "date");
  if (idxDate < 0 || idxDate <= idxComment) return null;

  const idxRowDiff = labels.findIndex(
    (h, i) =>
      i > idxComment &&
      i < idxDate &&
      i !== idxDiff &&
      (h === "difficulty" ||
        (h.includes("difficulty") && !h.includes("average") && !h.includes("mean")))
  );
  const bodyEnd = idxRowDiff >= 0 ? idxRowDiff : idxDate;
  return { idxDate, bodyEnd };
}

function commentMentionsLastName(commentText, lastNameKey) {
  if (!lastNameKey) return false;
  const hay = String(commentText ?? "").toLowerCase().replace(/\s+/g, "");
  const needle = String(lastNameKey).toLowerCase().replace(/\s+/g, "");
  return needle.length > 0 && hay.includes(needle);
}

/**
 * Sheet layout: … Comments (C), per-row Difficulty (D), Date (E); CSV export adds empty columns → ",,,…" when re-joined.
 * Strip trailing commas, then peel trailing ",<difficulty>,<M/D/YYYY>" (or ",<date>") and show "Date: …" above the comment.
 */
function normalizeDifficultyComment(raw) {
  let s = String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/(?:,\s*)+$/, "")
    .trim();
  if (!s) return s;

  const dateLine = (d) => `Date: ${d}`;
  const withRating = /^([\s\S]*),\s*\d{1,2}\s*,\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*$/;
  let m = s.match(withRating);
  if (m) {
    const body = m[1].trim();
    const date = m[2];
    const head = dateLine(date);
    return body ? `${head}\n\n${body}` : head;
  }
  const dateOnly = /^([\s\S]*),\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*$/;
  m = s.match(dateOnly);
  if (m) {
    const body = m[1].trim();
    const date = m[2];
    return body ? `${dateLine(date)}\n\n${body}` : dateLine(date);
  }
  return s;
}

/**
 * Sheet model: Col A = Class, B = Average Difficulty, C = Additional Comments, optional D = row Difficulty, E = Date;
 * trailing empty columns disappear into nothing (no comma run) when using structured cells.
 * @returns {{ found: boolean, difficulty?: string, comments?: string[], professorSpecific?: boolean, classDisplay?: string }}
 */
async function getHistoricalGrades(courseCode, professorName = "") {
  const csv = await getCachedGradeCsv();
  const rows = parseCsv(csv);
  if (rows.length < 1) {
    debugLog("[UCRX bg] Historical sheet: empty CSV");
    return { found: false };
  }

  const courseKey = normCourseKey(courseCode);
  if (!courseKey) return { found: false };

  const lastNameKey = extractLastNameKey(professorName);

  let headerRow = rows[0];
  let dataStart = 0;
  if (isLikelyHeaderRow(rows[0])) {
    dataStart = 1;
  } else {
    headerRow = ["Class", "Average Difficulty", "Additional Comments"];
  }

  const { idxClass, idxDiff, idxComment } = resolveThreeColumnIndices(headerRow);
  const structuredSlice = resolveStructuredCommentSlice(headerRow, idxDiff, idxComment);

  // The sheet is structured in blocks:
  // - First row of a block contains the class in Column A
  // - Subsequent rows for that class often have a blank Column A, with more comments
  // We collect all rows in the block until the class name changes.
  const matchingRows = [];
  let difficulty = "—";
  let inTargetBlock = false;
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 1) continue;

    const rawClassCell = String(row[idxClass] ?? "").trim();
    const cellClass = normalizeClassCell(rawClassCell);

    if (!inTargetBlock) {
      if (cellClass === courseKey) {
        inTargetBlock = true;
        matchingRows.push(row);
        const d = String(row[idxDiff] ?? "").trim();
        if (d) difficulty = d;
      }
      continue;
    }

    // We already found the first class row; keep collecting until a new class starts.
    if (rawClassCell && cellClass !== courseKey) break;

    matchingRows.push(row);
    const d = String(row[idxDiff] ?? "").trim();
    if (d) difficulty = d;
  }

  if (!matchingRows.length) {
    debugLog(
      `[UCRX bg] Historical sheet: no block found for class key="${courseKey}"`
    );
    return { found: false };
  }

  const allComments = [];
  for (const row of matchingRows) {
    // Comments sometimes contain commas but may not be quoted in the CSV export.
    // When that happens, the CSV parser will split the comment across multiple cells.
    // Prefer explicit Date / Difficulty columns when the date cell looks valid; else re-join from C and regex-parse.
    let c = "";
    if (structuredSlice) {
      const { idxDate, bodyEnd } = structuredSlice;
      const dateStr = String(row[idxDate] ?? "").trim();
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
        const body = row.slice(idxComment, bodyEnd).join(",").trim();
        c = body ? `Date: ${dateStr}\n\n${body}` : `Date: ${dateStr}`;
      }
    }
    if (!c) {
      c = normalizeDifficultyComment(row.slice(idxComment).join(","));
    }
    if (c) allComments.push(c);
  }

  let professorSpecificComments = [];
  if (lastNameKey) {
    professorSpecificComments = allComments.filter((c) =>
      commentMentionsLastName(c, lastNameKey)
    );
  }

  const comments =
    professorSpecificComments.length > 0
      ? professorSpecificComments
      : allComments;

  const showGeneralDisclaimer =
    Boolean(lastNameKey) &&
    professorSpecificComments.length === 0 &&
    allComments.length > 0;

  const classDisplay =
    String(courseCode ?? "").trim() || courseKey.toUpperCase();

  debugLog(
    `[UCRX bg] Historical sheet: class=${courseKey} rows=${matchingRows.length} comments=${comments.length} profFilter=${!!lastNameKey} profMatched=${professorSpecificComments.length > 0}`
  );

  return {
    found: true,
    difficulty,
    comments,
    professorSpecific: professorSpecificComments.length > 0,
    showGeneralDisclaimer,
    classDisplay
  };
}

// ---------- MyClassGrades (Data column UI payload) ----------
const UCR_SCHOOL_CODE = "ucr";
const MCG_UNAVAILABLE_MESSAGE =
  "MyClassGrades changed their API, so grade data is temporarily unavailable.";

const mcgMemCache = new Map();
const MC_MEM_TTL_MS = 24 * 60 * 60 * 1000;

function mcgMemCacheKey(type, parts) {
  return `${type}:${parts.join("|")}`;
}

function mcgMemGet(key) {
  const row = mcgMemCache.get(key);
  if (!row) return null;
  if (Date.now() > row.exp) {
    mcgMemCache.delete(key);
    return null;
  }
  return row.value;
}

function mcgMemSet(key, value, ttlMs = MC_MEM_TTL_MS) {
  mcgMemCache.set(key, { value, exp: Date.now() + ttlMs });
}

async function graphqlRequest(query, variables) {
  const res = await fetch(MYCLASSGRADES_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA_BROWSER,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON (${res.status})`);
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${json?.errors?.[0]?.message || text.slice(0, 120)}`);
    err.status = res.status;
    err.graphqlErrors = Array.isArray(json?.errors) ? json.errors : [];
    throw err;
  }
  if (json.errors && json.errors.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    const err = new Error(msg);
    err.graphqlErrors = json.errors;
    throw err;
  }
  return json.data;
}

function isMyClassGradesSchemaError(err) {
  const msg = String(err?.message ?? "").toLowerCase();
  const errors = Array.isArray(err?.graphqlErrors) ? err.graphqlErrors : [];
  if (
    msg.includes("cannot query field") ||
    msg.includes("unknown argument") ||
    msg.includes("unknown type")
  ) {
    return true;
  }
  return errors.some((item) => {
    const m = String(item?.message ?? "").toLowerCase();
    return (
      m.includes("cannot query field") ||
      m.includes("unknown argument") ||
      m.includes("unknown type")
    );
  });
}

function mcgNorm(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseCourseCode(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s || s === "—") return null;
  const spaced = s.match(/^([A-Za-z&]+)\s+(.+)$/);
  if (spaced) {
    return {
      subject: spaced[1].toUpperCase(),
      catalog: spaced[2].replace(/\s/g, "").toUpperCase(),
    };
  }
  const compact = s.match(/^([A-Za-z&]+)(\d[\w]*)$/i);
  if (compact) {
    return {
      subject: compact[1].toUpperCase(),
      catalog: compact[2].toUpperCase(),
    };
  }
  return null;
}

function catalogKey(subject, catalog) {
  return `${String(subject || "").toUpperCase()}|${String(catalog || "").toUpperCase().replace(/\s/g, "")}`;
}

function pickBestCourse(items, parsed) {
  if (!items?.length || !parsed) return null;
  const want = catalogKey(parsed.subject, parsed.catalog);
  let exact = items.find((item) => {
    const c = item?.course;
    return c && catalogKey(c.subjectCode, c.catalogNum) === want;
  });
  if (exact) return exact;
  const subj = parsed.subject.toUpperCase();
  const cat = parsed.catalog.toUpperCase();
  exact = items.find(
    (item) =>
      (item?.course?.subjectCode || "").toUpperCase() === subj &&
      String(item?.course?.catalogNum || "").toUpperCase() === cat
  );
  if (exact) return exact;
  return items[0];
}

const SEARCH_QUERY = `
query SearchCourses($searchTerm: String!, $limit: Int!, $offset: Int!) {
  courses {
    searchCatalogCourses(
      input: {
        searchTerm: $searchTerm
        schoolCode: "${UCR_SCHOOL_CODE}"
        hasGrades: true
        limit: $limit
        offset: $offset
      }
    ) {
      items {
        matchKind
        matchedInstructors
        course {
          id
          subjectCode
          catalogNum
          title
          averageGpa
          totalStudents
        }
      }
    }
  }
}
`;

const COURSE_DETAIL_QUERY = `
query CatalogCourseDetail($id: ID!) {
  courses {
    catalogCourse(id: $id) {
      id
      subjectCode
      catalogNum
      title
      averageGpa
      totalStudents
      gradeAggregate {
        totalStudents
        totalTerms
        totalProfessors
        gradeAPlus
        gradeA
        gradeAMinus
        gradeBPlus
        gradeB
        gradeBMinus
        gradeCPlus
        gradeC
        gradeCMinus
        gradeDPlus
        gradeD
        gradeDMinus
        gradeF
        gradeNp
        gradeW
        gradeS
      }
      gradeHistory {
        termString
        termCode
        totalStudents
        averageGpa
        instructors {
          name
        }
        gradeAPlus
        gradeA
        gradeAMinus
        gradeBPlus
        gradeB
        gradeBMinus
        gradeCPlus
        gradeC
        gradeCMinus
        gradeDPlus
        gradeD
        gradeDMinus
        gradeF
        gradeNp
        gradeW
        gradeS
      }
    }
  }
}
`;

function namesLikelyMatch(apiName, targets) {
  const api = mcgNorm(apiName);
  if (!api) return false;
  const apiParts = api.split(/\s+/).filter(Boolean);
  const apiLast = apiParts[apiParts.length - 1] || "";

  for (const t of targets) {
    const tn = mcgNorm(t);
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

function rowMatchesProfessors(row, professorNames) {
  const targets = (professorNames || []).map((x) => String(x).trim()).filter(Boolean);
  if (!targets.length) return true;
  const inst = row.instructors || [];
  return inst.some((i) => namesLikelyMatch(i.name, targets));
}

function aggregateInstructorsFromHistory(gradeHistory, professorNames) {
  const map = new Map();
  for (const row of gradeHistory || []) {
    const n = row.totalStudents;
    const gpa = row.averageGpa;
    if (!n || gpa == null) continue;
    for (const ins of row.instructors || []) {
      const name = ins.name;
      if (!name) continue;
      const cur = map.get(name) || { name, sum: 0, graded: 0 };
      cur.sum += gpa * n;
      cur.graded += n;
      map.set(name, cur);
    }
  }
  const list = Array.from(map.values()).map((x) => ({
    name: x.name,
    averageGpa: x.graded ? Math.round((x.sum / x.graded) * 100) / 100 : null,
    graded: x.graded,
  }));

  const targets = (professorNames || []).map((x) => String(x).trim()).filter(Boolean);
  if (targets.length) {
    list.sort((a, b) => {
      const ma = targets.some((t) => namesLikelyMatch(a.name, [t])) ? 1 : 0;
      const mb = targets.some((t) => namesLikelyMatch(b.name, [t])) ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return b.graded - a.graded;
    });
  } else {
    list.sort((a, b) => b.graded - a.graded);
  }
  return list;
}

function filterHistoryForProf(gradeHistory, primaryInstructor, teamInstructors) {
  const rows = gradeHistory || [];
  const primaryRaw = String(primaryInstructor || "").trim();
  const primary = primaryRaw && primaryRaw !== "—" ? primaryRaw : "";
  const team = (teamInstructors || []).map((x) => String(x).trim()).filter(Boolean);

  if (primary) {
    const hit = rows.filter((r) => rowMatchesProfessors(r, [primary]));
    if (hit.length) {
      return { rows: hit, filtered: true, disclaimer: null, mode: "primary" };
    }
  }
  if (team.length) {
    const hit = rows.filter((r) => rowMatchesProfessors(r, team));
    if (hit.length) {
      return { rows: hit, filtered: true, disclaimer: null, mode: "team" };
    }
  }
  if (team.length) {
    return {
      rows: [...rows],
      filtered: false,
      disclaimer: `No sections matched "${team.join(", ")}". Showing all sections for this course.`,
      mode: "all",
    };
  }
  return { rows: [...rows], filtered: false, disclaimer: null, mode: "none" };
}

function weightedGpaFromSectionRows(rows) {
  let sum = 0;
  let students = 0;
  for (const r of rows || []) {
    const ts = Number(r.totalStudents) || 0;
    const g = r.averageGpa;
    if (ts > 0 && g != null && !Number.isNaN(Number(g))) {
      sum += Number(g) * ts;
      students += ts;
    }
  }
  if (!students) return { gpa: null, students: 0 };
  return { gpa: Math.round((sum / students) * 100) / 100, students };
}

function sortGradeHistoryRows(history) {
  return [...(history || [])].sort((a, b) => {
    const ta = String(a.termString || "");
    const tb = String(b.termString || "");
    return tb.localeCompare(ta, undefined, { numeric: true });
  });
}

/** Stable chrome.storage key: one canonical blob per course (not per professor). */
function mcgCanonicalCacheKey(courseCode) {
  const parsed = parseCourseCode(courseCode);
  const id = parsed
    ? catalogKey(parsed.subject, parsed.catalog)
    : normCourseKey(courseCode);
  return cacheKey("MCG", `v${MCG_CANONICAL_CACHE_VERSION}::${id}`);
}

/**
 * Fetch + normalize course grade data (full section history). No professor filtering.
 * @returns {Promise<object>}
 */
async function fetchMyClassGradesCanonical(courseCode) {
  const parsed = parseCourseCode(courseCode);
  if (!parsed) {
    return { ok: false, error: "Could not parse course code from this row." };
  }

  try {
    const searchTerm = `${parsed.subject} ${parsed.catalog}`;
    const ck = mcgMemCacheKey("mcg", [searchTerm]);
    let items = mcgMemGet(ck);
    if (!items) {
      const data = await graphqlRequest(SEARCH_QUERY, {
        searchTerm,
        limit: 16,
        offset: 0,
      });
      items = data?.courses?.searchCatalogCourses?.items || [];
      mcgMemSet(ck, items);
    }

    const best = pickBestCourse(items, parsed);
    const bestCourse = best?.course || null;
    if (!bestCourse?.id) {
      return { ok: false, error: "No matching course found in grade data." };
    }

    const dk = mcgMemCacheKey("mcgCourse", [bestCourse.id]);
    let detail = mcgMemGet(dk);
    if (!detail) {
      const data = await graphqlRequest(COURSE_DETAIL_QUERY, { id: bestCourse.id });
      detail = data?.courses?.catalogCourse;
      if (detail) mcgMemSet(dk, detail);
    }

    if (!detail) {
      return { ok: false, error: "Course detail request returned empty." };
    }

    const agg = detail.gradeAggregate || null;
    const historyFull = sortGradeHistoryRows(detail.gradeHistory || []);

    return {
      ok: true,
      _mcgCanonical: true,
      course: {
        id: detail.id,
        subjectCode: detail.subjectCode,
        catalogNum: detail.catalogNum,
        title: detail.title,
        averageGpa: detail.averageGpa,
        totalStudents: detail.totalStudents,
      },
      gradeAggregate: agg,
      gradeHistory: historyFull,
      searchMatch: {
        subjectCode: bestCourse.subjectCode,
        catalogNum: bestCourse.catalogNum,
        title: bestCourse.title,
      },
    };
  } catch (err) {
    if (isMyClassGradesSchemaError(err)) {
      console.warn("[UCRX bg] MyClassGrades schema mismatch", err);
      return { ok: false, error: MCG_UNAVAILABLE_MESSAGE };
    }
    throw err;
  }
}

/**
 * Apply row instructor filter to a canonical course payload (no network).
 */
function applyMcgProfessorView(canonical, professorNames, primaryInstructor) {
  if (!canonical || typeof canonical !== "object") {
    return { ok: false, error: "Invalid MyClassGrades cache entry." };
  }
  if (!canonical.ok) return { ...canonical };

  const historyFull = canonical.gradeHistory || [];
  const { rows: historyRows, filtered, disclaimer, mode: historyFilterMode } = filterHistoryForProf(
    historyFull,
    primaryInstructor,
    professorNames
  );
  const historyAll = sortGradeHistoryRows(historyFull);
  const historyByProfessor = sortGradeHistoryRows(historyRows);
  const matchedStats = weightedGpaFromSectionRows(historyByProfessor);
  const instructorAverages = aggregateInstructorsFromHistory(historyFull, professorNames);

  return {
    course: canonical.course,
    gradeAggregate: canonical.gradeAggregate,
    searchMatch: canonical.searchMatch,
    gradeHistory: historyAll,
    gradeHistoryByProfessor: historyByProfessor,
    historyFiltered: filtered,
    historyDisclaimer: disclaimer,
    historyFilterMode,
    sectionWeightedGpa: matchedStats.gpa,
    sectionWeightedStudents: matchedStats.students,
    instructorAverages,
    ok: true,
  };
}

async function getCachedCanonicalMyClassGrades(courseCode) {
  const key = mcgCanonicalCacheKey(courseCode);
  const hit = await cacheGet(key);
  if (hit != null) return { data: hit, cached: true };

  const data = await fetchMyClassGradesCanonical(courseCode);
  if (data?.ok) await cacheSet(key, data, MCG_RESPONSE_CACHE_TTL_MS);
  return { data, cached: false };
}

async function getMyClassGradesForRequest(courseCode, professorNames, primaryInstructor) {
  const { data: canonical, cached } = await getCachedCanonicalMyClassGrades(courseCode);
  const view = applyMcgProfessorView(canonical, professorNames, primaryInstructor);
  return { payload: view, cached };
}


// ---------- Message Router ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "FETCH_RMP": {
        const profName = String(message.profName ?? "").trim();
        if (!profName) {
          sendResponse({ ok: false, error: "Missing profName" });
          return;
        }
        try {
          const key = cacheKey("RMP", `v${RMP_CACHE_VERSION}::${profName}`);
          const cached = await cachedFetch(key, () => getRmpProfessorData(profName));
          sendResponse({ ok: true, data: cached.data, cached: cached.cached });
        } catch (e) {
          console.error("[UCRX bg] FETCH_RMP unexpected", e);
          sendResponse({
            ok: true,
            data: { found: false, useSearchFallback: true }
          });
        }
        return;
      }

      case "FETCH_SHEET_GRADES": {
        const courseCode = String(message.courseCode ?? "").trim();
        const professorName = String(message.professorName ?? "").trim();
        if (!courseCode) {
          sendResponse({ ok: false, error: "Missing courseCode" });
          return;
        }
        try {
          const key = cacheKey(
            "SHEET",
            `v${SHEET_RESULT_CACHE_VERSION}::${courseCode}::${professorName || "all"}`
          );
          const cached = await cachedFetch(key, () => getHistoricalGrades(courseCode, professorName));
          sendResponse({ ok: true, data: cached.data, cached: cached.cached });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e?.message ?? "Unknown error",
            status: e?.status,
            body: previewText(e?.body)
          });
        }
        return;
      }

      case "FETCH_MYCLASSGRADES": {
        const courseCode = String(message.courseCode ?? "").trim();
        const professorNames = Array.isArray(message.professorNames)
          ? message.professorNames
          : [];
        const primaryInstructor = String(message.primaryInstructor ?? "").trim();
        if (!courseCode) {
          sendResponse({ ok: false, error: "Missing courseCode" });
          return;
        }
        try {
          const { payload, cached } = await getMyClassGradesForRequest(
            courseCode,
            professorNames,
            primaryInstructor
          );
          if (payload && typeof payload === "object") {
            sendResponse({ ...payload, cached });
          } else {
            sendResponse({ ok: false, error: "Unexpected MyClassGrades response" });
          }
        } catch (e) {
          sendResponse({
            ok: false,
            error: e?.message ?? "Unknown error",
            status: e?.status,
            body: previewText(e?.body),
          });
        }
        return;
      }

      default:
        return;
    }
  })();

  return true;
});
