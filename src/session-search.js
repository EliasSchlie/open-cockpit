// Session search: fuzzy search overlay for quickly jumping to sessions
import { state, dom, STATUS_CLASSES, escapeHtml } from "./renderer-state.js";

// --- Cross-module dependencies (set via initSessionSearch) ---
let _actions = {};

export function initSessionSearch(actions) {
  _actions = actions;

  dom.sessionSearchInput.addEventListener("input", () => {
    selectedIndex = 0;
    renderResults(dom.sessionSearchInput.value);
  });

  dom.sessionSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSessionSearch();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      updateSelection(Math.min(selectedIndex + 1, filteredSessions.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      updateSelection(Math.max(selectedIndex - 1, 0));
      return;
    }
    if (e.key === "Enter" && filteredSessions.length > 0) {
      e.preventDefault();
      const session = filteredSessions[selectedIndex];
      closeSessionSearch();
      _actions.selectSession(session);
      return;
    }
  });

  dom.sessionSearch.addEventListener("click", (e) => {
    if (e.target === dom.sessionSearch) closeSessionSearch();
  });
}

// --- State ---
let selectedIndex = 0;
let filteredSessions = [];

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
      if (ti === 0 || /[\s/\-_.]/.test(t[ti - 1])) score += 5;
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
    { text: session.intentionHeading || "", weight: 3 },
    { text: session.project || "", weight: 2 },
    {
      text: session.cwd ? session.cwd.replace(session.home || "", "~") : "",
      weight: 1,
    },
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
function recencyBonus(session) {
  const now = Date.now();
  // Use idleTs if available, otherwise approximate from status
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
  if (dom.sessionSearch.classList.contains("visible")) {
    closeSessionSearch();
  } else {
    openSessionSearch();
  }
}

function openSessionSearch() {
  dom.sessionSearch.classList.add("visible");
  dom.sessionSearchInput.value = "";
  selectedIndex = 0;
  renderResults("");
  dom.sessionSearchInput.focus();
  window.api.setDialogOpen(true);
}

function closeSessionSearch() {
  dom.sessionSearch.classList.remove("visible");
  dom.sessionSearchInput.value = "";
  window.api.setDialogOpen(false);
  _actions.focusTerminal();
}

// --- Rendering ---

function renderResults(query) {
  const sessions = state.cachedSessions;
  const q = query.trim();

  if (!q) {
    // No query: show all sessions sorted by recency
    filteredSessions = [...sessions].sort(
      (a, b) => recencyBonus(b) - recencyBonus(a),
    );
  } else {
    // Score and filter
    const scored = [];
    for (const s of sessions) {
      const matchScore = scoreSession(s, q);
      if (matchScore < 0) continue;
      scored.push({ session: s, score: matchScore + recencyBonus(s) });
    }
    scored.sort((a, b) => b.score - a.score);
    filteredSessions = scored.map((s) => s.session);
  }

  selectedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredSessions.length - 1),
  );

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
    item.className = `session-search-item${i === selectedIndex ? " selected" : ""}`;

    const statusClass = STATUS_CLASSES[s.status] || "dead";
    const heading = escapeHtml(s.intentionHeading || "Untitled");
    const path = escapeHtml(s.cwd ? s.cwd.replace(s.home || "", "~") : "~");
    const origin = s.origin || "ext";

    item.innerHTML = `
      <div class="session-search-main">
        <span class="session-status ${statusClass}"></span>
        <span class="session-search-heading">${heading}</span>
        <span class="session-search-origin origin-${origin}">${origin}</span>
      </div>
      <div class="session-search-meta">${path}</div>
    `;

    item.addEventListener("click", () => {
      closeSessionSearch();
      _actions.selectSession(s);
    });
    item.addEventListener("mouseenter", () => updateSelection(i));
    list.appendChild(item);
  }
}

function updateSelection(newIndex) {
  const items = dom.sessionSearchList.querySelectorAll(".session-search-item");
  if (items[selectedIndex]) items[selectedIndex].classList.remove("selected");
  selectedIndex = newIndex;
  if (items[selectedIndex]) {
    items[selectedIndex].classList.add("selected");
    items[selectedIndex].scrollIntoView({ block: "nearest" });
  }
}
