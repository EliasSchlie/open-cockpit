// Session search: fuzzy search overlay for quickly jumping to sessions
import { state, dom, STATUS_CLASSES, escapeHtml } from "./renderer-state.js";
import { STATUS, ORIGIN } from "./session-statuses.js";
import { createPickerOverlay } from "./picker-overlay.js";

// Hoisted regex for word boundary detection in fuzzy scoring
const BOUNDARY_RE = /[\s/\-_.]/;

// --- Cross-module dependencies (set via initSessionSearch) ---
let _actions = {};
let _displayPath = (s) => s.cwd || "~";
let filteredSessions = [];
let picker;

export function initSessionSearch(actions) {
  _actions = actions;
  if (actions.displayPath) _displayPath = actions.displayPath;

  picker = createPickerOverlay({
    overlayEl: dom.sessionSearch,
    inputEl: dom.sessionSearchInput,
    listEl: dom.sessionSearchList,
    onInput: (query) => renderResults(query),
    onSelect: (index) => {
      _actions.selectSession(filteredSessions[index]);
    },
    onOpen: () => renderResults(""),
    onClose: () => {
      filteredSessions = [];
      _actions.focusTerminal();
    },
    getItemCount: () => filteredSessions.length,
  });
}

// --- Fuzzy matching ---

// Simple fuzzy match: each query character must appear in order in the target.
// Returns a score (higher = better) or -1 if no match.
function fuzzyScore(query, target) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatchIdx = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Bonus for consecutive matches
      if (ti === prevMatchIdx + 1) score += 3;
      // Bonus for match at word boundary (start, after space/slash/dash)
      if (ti === 0 || BOUNDARY_RE.test(t[ti - 1])) score += 5;
      // Base match point
      score += 1;
      prevMatchIdx = ti;
      qi++;
    }
  }

  // All query chars must match
  if (qi < q.length) return -1;
  return score;
}

// Score a session against a query. Returns -1 if no match.
function scoreSession(session, query) {
  if (!query) return 0;

  const fields = [
    {
      text: session.intentionHeading || session.intentionPreview || "",
      weight: 3,
    },
    { text: session.project || "", weight: 2 },
    { text: _displayPath(session), weight: 1 },
  ];

  let bestScore = -1;
  for (const { text, weight } of fields) {
    if (!text) continue;
    const s = fuzzyScore(query, text);
    if (s >= 0) bestScore = Math.max(bestScore, s * weight);
  }
  return bestScore;
}

// --- Recency scoring ---

// Sessions are sorted by combined score: fuzzy match quality + recency bonus.
// Recency uses idleTs for live sessions, or meta timestamp for offloaded/archived.
function recencyBonus(session, now) {
  const ts = session.idleTs || session.offloadedAt || 0;
  if (!ts) return 0;
  const ageMs = now - ts;
  const ageHours = ageMs / (1000 * 60 * 60);
  // Logarithmic decay: recent sessions get a bigger bonus
  if (ageHours <= 0) return 10;
  return Math.max(0, 10 - Math.log2(ageHours + 1) * 2);
}

// --- Open/close ---

export function toggleSessionSearch() {
  picker.toggle();
}

// --- Rendering ---

function renderResults(query) {
  const sessions = state.cachedSessions;
  const q = query.trim();
  const now = Date.now();

  if (!q) {
    // No query: show all sessions sorted by recency
    filteredSessions = [...sessions].sort(
      (a, b) => recencyBonus(b, now) - recencyBonus(a, now),
    );
  } else {
    // Score and filter
    const scored = [];
    for (const s of sessions) {
      const matchScore = scoreSession(s, q);
      if (matchScore < 0) continue;
      scored.push({ session: s, score: matchScore + recencyBonus(s, now) });
    }
    scored.sort((a, b) => b.score - a.score);
    filteredSessions = scored.map((s) => s.session);
  }

  const clamped = picker.clampSelection();

  const list = dom.sessionSearchList;
  list.innerHTML = "";

  if (filteredSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-search-empty";
    empty.textContent = "No sessions found";
    list.appendChild(empty);
    return;
  }

  for (let i = 0; i < filteredSessions.length; i++) {
    const s = filteredSessions[i];
    const item = document.createElement("div");
    item.className = `overlay-picker-item session-search-item${i === clamped ? " selected" : ""}`;

    const statusClass = STATUS_CLASSES[s.status] || "dead";
    const headingText = s.intentionHeading || s.intentionPreview || null;
    const isPreview = !s.intentionHeading && !!s.intentionPreview;
    const heading = headingText
      ? escapeHtml(headingText)
      : '<span class="dim">Untitled</span>';
    const headingClass = isPreview ? " preview" : "";
    const path = escapeHtml(_displayPath(s));

    // Show origin for live sessions, status label for offloaded/archived
    const isOffloadedOrArchived =
      s.status === STATUS.OFFLOADED || s.status === STATUS.ARCHIVED;
    const tagText = isOffloadedOrArchived ? s.status : s.origin || ORIGIN.EXT;
    const safeOrigin = (s.origin || ORIGIN.EXT).replace(/[^a-z0-9-]/gi, "-");
    const tagClass = isOffloadedOrArchived
      ? `status-${statusClass}`
      : `origin-${safeOrigin}`;

    item.innerHTML = `
      <div class="session-search-main">
        <span class="session-status ${statusClass}"></span>
        <span class="session-search-heading${headingClass}">${heading}</span>
        <span class="session-search-tag ${tagClass}">${escapeHtml(tagText)}</span>
      </div>
      <div class="session-search-meta">${path}</div>
    `;

    item.addEventListener("mouseenter", () => picker.updateSelection(i));
    list.appendChild(item);
  }
}
