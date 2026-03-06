// Session sidebar: directory colors, session list, context menu, snapshot viewer
import {
  state,
  dom,
  debugLog,
  STATUS_CLASSES,
  escapeHtml,
} from "./renderer-state.js";
import { STATUS } from "./session-statuses.js";
import {
  createDefaultLayout,
  TAB_EDITOR,
  TAB_SNAPSHOT,
  registerEditorTab,
} from "./dock-helpers.js";

// --- Callbacks into renderer.js (set via initSidebar) ---
let _actions = {};
export function initSidebar(actions) {
  _actions = actions;
}

// --- Directory color coding ---
// Neon-friendly palette for directory indicators
const DIR_COLORS = [
  "#ff1a1a", // neon red
  "#00ff41", // neon green
  "#ff6600", // neon orange
  "#00ccff", // neon cyan
  "#ff00ff", // neon magenta
  "#ffff00", // neon yellow
  "#7b68ee", // neon purple
  "#ff69b4", // neon pink
  "#00ff88", // neon mint
  "#ff4500", // neon vermillion
];

// User-configured colors from ~/.open-cockpit/colors.json
// Format: { "~/Documents/Projects/foo": "#ff00ff" }
// null value = no color (transparent)
let userDirColors = {};

async function loadDirColors() {
  userDirColors = await window.api.getDirColors();
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Get the path used for color hashing.
// - Worktrees (.claude/worktrees/xxx) → parent project dir
// - Inside a git repo → git root
// - Otherwise → exact cwd (each folder gets its own color)
function getColorKey(session) {
  const { cwd, gitRoot, home } = session;
  if (!cwd) return "";
  // Strip worktree suffix (.claude/worktrees/xxx or .wt/xxx)
  const wtMatch = cwd.match(/^(.+?)\/(?:\.claude\/worktrees|\.wt)\/.+$/);
  const resolved = wtMatch ? wtMatch[1] : cwd;
  // If inside a git repo, use the git root
  if (gitRoot) {
    // Also handle worktree: if the worktree-stripped path has a git root,
    // use the worktree-stripped path (it IS the git root)
    if (wtMatch) return wtMatch[1];
    return gitRoot;
  }
  return resolved;
}

function getDirColor(session) {
  const { cwd, home } = session;
  if (!cwd) return null;
  // Home directory exactly → no color
  if (cwd === home) return null;

  const colorKey = getColorKey(session);

  // Check user config — match longest prefix first
  const configKeys = Object.keys(userDirColors).sort(
    (a, b) => b.length - a.length,
  );
  for (const key of configKeys) {
    const expandedKey = home ? key.replace(/^~/, home) : key;
    if (colorKey === expandedKey || colorKey.startsWith(expandedKey + "/")) {
      return userDirColors[key]; // null = no color, string = exact color
    }
  }

  return DIR_COLORS[hashString(colorKey) % DIR_COLORS.length];
}

// Build a fingerprint for a session to detect changes
function sessionFingerprint(s) {
  return `${s.sessionId}|${s.status}|${s.staleIdle ? "stale" : ""}|${s.intentionHeading || ""}|${s.intentionPreview || ""}|${s.cwd || ""}|${s.origin || ""}`;
}

// Track previous session fingerprints for diff-based update
let prevSessionFingerprints = null;

// Play a short bell tone via Web Audio API
let bellCtx = null;
function playBell() {
  try {
    if (!bellCtx) bellCtx = new AudioContext();
    if (bellCtx.state === "suspended") bellCtx.resume();
    const osc = bellCtx.createOscillator();
    const gain = bellCtx.createGain();
    osc.connect(gain);
    gain.connect(bellCtx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, bellCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, bellCtx.currentTime + 0.3);
    osc.start(bellCtx.currentTime);
    osc.stop(bellCtx.currentTime + 0.3);
  } catch (_) {
    // Audio not available — ignore
  }
}

// --- Session list ---
let archiveExpanded = false;

async function loadSessions() {
  const sessions = await window.api.getSessions();
  const oldStatuses = new Map(
    state.cachedSessions.map((s) => [s.sessionId, s.status]),
  );
  state.cachedSessions = sessions;

  // Keep CWD in sync (may change as JSONL records cd commands)
  if (state.currentSessionId) {
    const current = sessions.find(
      (s) => s.sessionId === state.currentSessionId,
    );
    if (current?.cwd) state.currentSessionCwd = current.cwd;
  }

  _actions.cleanupStaleTerminals(sessions);
  _actions.updatePoolHealthBadge();

  // Split into sections — pool and external mixed together
  const typing = sessions.filter((s) => s.status === STATUS.TYPING);
  const recent = sessions.filter(
    (s) => s.status === STATUS.IDLE || s.status === STATUS.OFFLOADED,
  );
  const processing = sessions.filter((s) => s.status === STATUS.PROCESSING);
  const archived = sessions.filter((s) => s.status === STATUS.ARCHIVED);

  // Build fingerprint to check if anything changed
  const allItems = [...typing, ...recent, ...processing, ...archived];
  const fingerprints = allItems.map(sessionFingerprint).join("\n");
  if (fingerprints === prevSessionFingerprints) {
    // Only update active class (selected session may have changed)
    for (const li of dom.sessionList.querySelectorAll(".session-item")) {
      li.classList.toggle(
        "active",
        li.dataset.sessionId === state.currentSessionId,
      );
    }
    return;
  }
  prevSessionFingerprints = fingerprints;

  // Bell when a session transitions to idle (finished processing)
  if (oldStatuses.size > 0) {
    for (const s of sessions) {
      if (
        s.status === STATUS.IDLE &&
        oldStatuses.has(s.sessionId) &&
        oldStatuses.get(s.sessionId) !== STATUS.IDLE
      ) {
        playBell();
        break;
      }
    }
  }

  // Full rebuild only when sessions actually changed
  dom.sessionList.innerHTML = "";

  if (
    typing.length === 0 &&
    recent.length === 0 &&
    processing.length === 0 &&
    archived.length === 0
  ) {
    dom.sessionList.innerHTML =
      '<li style="padding: 12px; color: var(--text-dim); font-size: 13px;">No sessions found</li>';
    return;
  }

  function addSection(label, items) {
    if (items.length === 0) return;
    const header = document.createElement("li");
    header.className = "session-section-header";
    header.textContent = `${label} (${items.length})`;
    dom.sessionList.appendChild(header);
    for (const s of items) {
      dom.sessionList.appendChild(createSessionItem(s));
    }
  }

  addSection("Typing", typing);
  addSection("Recent", recent);
  addSection("Processing", processing);

  // Archive section: collapsible, shows first 5 by default
  if (archived.length > 0) {
    const ARCHIVE_VISIBLE = 5;
    const header = document.createElement("li");
    header.className = "session-section-header session-section-collapsible";
    const collapsed = archived.length > ARCHIVE_VISIBLE && !archiveExpanded;
    header.innerHTML = `<span class="section-toggle">${archiveExpanded ? "▾" : "▸"}</span> Archive (${archived.length})`;
    if (archived.length > ARCHIVE_VISIBLE) {
      header.addEventListener("click", () => {
        archiveExpanded = !archiveExpanded;
        loadSessions();
      });
    }
    dom.sessionList.appendChild(header);
    const visible = collapsed ? archived.slice(0, ARCHIVE_VISIBLE) : archived;
    for (const s of visible) {
      dom.sessionList.appendChild(createSessionItem(s));
    }
    if (collapsed) {
      const more = document.createElement("li");
      more.className = "session-section-more";
      more.textContent = `+${archived.length - ARCHIVE_VISIBLE} more`;
      more.addEventListener("click", () => {
        archiveExpanded = true;
        loadSessions();
      });
      dom.sessionList.appendChild(more);
    }
  }
}

function createSessionItem(s) {
  const li = document.createElement("li");
  li.className = `session-item${s.sessionId === state.currentSessionId ? " active" : ""}${s.status === STATUS.OFFLOADED || s.status === STATUS.ARCHIVED ? " offloaded" : ""}`;
  li.dataset.sessionId = s.sessionId;
  const heading = s.intentionHeading || s.intentionPreview || null;
  const isPreview = !s.intentionHeading && !!s.intentionPreview;
  const dp = displayPath(s);
  const dirColor = getDirColor(s);
  const indicatorStyle = dirColor
    ? `background: ${dirColor}; box-shadow: 0 0 4px ${dirColor}`
    : "background: transparent";
  const showOrigin =
    s.origin && s.status !== STATUS.OFFLOADED && s.status !== STATUS.ARCHIVED;
  const originTag = showOrigin
    ? `<span class="session-origin-tag session-origin-${escapeHtml(s.origin)}">${escapeHtml(s.origin)}</span>`
    : "";
  const staleTag = s.staleIdle
    ? `<span class="session-origin-tag session-origin-stale">stale</span>`
    : "";
  const pinned = s.pinnedUntil && new Date(s.pinnedUntil) > new Date();
  const pinnedTag = pinned
    ? '<span class="session-origin-tag session-origin-pinned" title="Pinned — won\'t be offloaded">📌</span>'
    : "";
  li.innerHTML = `
    <div class="session-dir-indicator" style="${indicatorStyle}"></div>
    <div class="session-item-content">
      <div class="session-project">
        <span class="session-status ${STATUS_CLASSES[s.status] || "dead"}"></span>
        <span class="session-title${isPreview ? " session-preview" : ""}">${escapeHtml(heading || "No intention yet")}</span>
        ${originTag}${staleTag}${pinnedTag}
      </div>
      <div class="session-cwd">${escapeHtml(dp)}</div>
    </div>
  `;
  li.addEventListener("click", () => _actions.selectSession(s));
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showSessionContextMenu(e, s);
  });
  return li;
}

// Right-click context menu for sessions
function showSessionContextMenu(e, session) {
  const existing = document.getElementById("session-context-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "session-context-menu";
  menu.className = "session-context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const isArchived = session.status === STATUS.ARCHIVED;
  const isOffloaded = session.status === STATUS.OFFLOADED;

  if (isArchived) {
    menu.innerHTML = `
      <div class="session-context-item" data-action="restart">Restart</div>
      <div class="session-context-item" data-action="unarchive">Move to Recent</div>
    `;
  } else if (isOffloaded) {
    menu.innerHTML = `
      <div class="session-context-item" data-action="resume">Resume</div>
      <div class="session-context-item" data-action="archive">Archive</div>
    `;
  } else {
    menu.innerHTML = `
      <div class="session-context-item" data-action="archive">Archive</div>
    `;
  }

  document.body.appendChild(menu);

  const close = () => menu.remove();
  setTimeout(() => document.addEventListener("click", close, { once: true }));

  menu.addEventListener("click", async (ev) => {
    const action = ev.target.dataset.action;
    menu.remove();
    if (action === "archive") {
      try {
        await window.api.archiveSession(session.sessionId);
      } catch (err) {
        console.error("Failed to archive session:", err);
      }
      await loadSessions();
    } else if (action === "unarchive") {
      try {
        await window.api.unarchiveSession(session.sessionId);
      } catch (err) {
        console.error("Failed to unarchive session:", err);
      }
      await loadSessions();
    } else if (action === "restart") {
      try {
        await window.api.unarchiveSession(session.sessionId);
      } catch (err) {
        console.error("Failed to unarchive session for restart:", err);
      }
      await _actions.resumeOffloadedSession(session);
    } else if (action === "resume") {
      await _actions.resumeOffloadedSession(session);
    }
  });
}

// Show read-only snapshot viewer
function showSnapshotViewer(session, snapshotText) {
  const existing = document.getElementById("snapshot-viewer");
  if (existing) existing.remove();

  const viewer = document.createElement("div");
  viewer.id = "snapshot-viewer";
  viewer.className = "offload-menu-overlay";
  viewer.innerHTML = `
    <div class="snapshot-dialog">
      <div class="snapshot-header">
        <span>${escapeHtml(session.intentionHeading || "Snapshot")}</span>
        <button class="snapshot-close">\u2715</button>
      </div>
      <pre class="snapshot-content">${snapshotText ? escapeHtml(snapshotText) : "(no snapshot available)"}</pre>
    </div>
  `;

  document.body.appendChild(viewer);

  function closeViewer() {
    document.removeEventListener("keydown", escHandler, true);
    viewer.remove();
  }
  function escHandler(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeViewer();
    }
  }
  document.addEventListener("keydown", escHandler, true);

  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) closeViewer();
  });
  viewer
    .querySelector(".snapshot-close")
    .addEventListener("click", closeViewer);
}

// Show snapshot content inline as a dock tab for offloaded/archived sessions
async function showInlineSnapshot(session, gen) {
  const isArchived = session.status === STATUS.ARCHIVED;
  const btnLabel = isArchived ? "Restart" : "Resume";

  let snapshotText = null;
  if (session.hasSnapshot) {
    try {
      snapshotText = await window.api.readOffloadSnapshot(session.sessionId);
    } catch (err) {
      debugLog("snapshot", `failed to read snapshot: ${err.message}`);
    }
    if (gen !== state.sessionGeneration) return;
  }

  // Create snapshot content element
  const container = document.createElement("div");
  container.className = "dock-snapshot-content";
  container.innerHTML = `
    <div class="inline-snapshot-header">
      <span class="inline-snapshot-label">${isArchived ? "Archived" : "Offloaded"} Session</span>
      <button class="inline-snapshot-restart">${btnLabel}</button>
    </div>
    <pre class="snapshot-content inline-snapshot-content">${snapshotText ? escapeHtml(snapshotText) : "(no snapshot available)"}</pre>
  `;

  container
    .querySelector(".inline-snapshot-restart")
    .addEventListener("click", async () => {
      if (isArchived) {
        try {
          await window.api.unarchiveSession(session.sessionId);
        } catch (err) {
          debugLog("snapshot", `unarchive failed: ${err.message}`);
        }
      }
      await _actions.resumeOffloadedSession(session);
    });

  // Register snapshot as a dock tab
  _actions.ensureEditorContainer();
  _actions.ensureDock();
  state.dock.registerTab(TAB_SNAPSHOT, {
    type: TAB_SNAPSHOT,
    label: isArchived ? "Archived" : "Snapshot",
    closable: false,
    contentEl: container,
  });
  registerEditorTab(state.dock, state.editorContainer);
  state.dock.setLayout(createDefaultLayout([TAB_SNAPSHOT], [TAB_EDITOR]));
}

// Clean up inline snapshot when switching away from an offloaded/archived session
function removeInlineSnapshot() {
  if (state.dock) {
    state.dock.unregisterTab(TAB_SNAPSHOT);
  }
}

function displayPath(session) {
  return session.cwd ? session.cwd.replace(session.home, "~") : "~";
}

// --- Sidebar invalidation & typing state ---
let typingRefreshTimeout;

function invalidateSidebar() {
  prevSessionFingerprints = null;
  loadSessions();
}

// After editing a fresh/typing session, refresh sidebar so main re-checks intention file
function updateTypingState() {
  if (!state.currentSessionId) return;
  const session = state.cachedSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  if (
    !session ||
    (session.status !== STATUS.FRESH && session.status !== STATUS.TYPING)
  ) {
    return;
  }
  // Immediately update sidebar preview from local editor content (no round-trip)
  updateTypingPreview();
  // Also schedule full refresh so main process picks up the status change
  clearTimeout(typingRefreshTimeout);
  typingRefreshTimeout = setTimeout(invalidateSidebar, 600); // after 500ms save debounce
}

// Update the current session's sidebar preview directly from local editor content
function updateTypingPreview() {
  if (!state.currentSessionId || !state.editorView) return;
  const li = dom.sessionList.querySelector(
    `[data-session-id="${state.currentSessionId}"]`,
  );
  if (!li) return;
  const titleSpan = li.querySelector(".session-title");
  if (!titleSpan) return;
  const session = state.cachedSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  if (!session || session.intentionHeading) return;
  const raw = state.editorView.state.doc.toString().trim();
  const preview = raw
    .replace(/^#\s+.*\n?/, "")
    .trim()
    .slice(0, 80);
  titleSpan.textContent = preview || "No intention yet";
  titleSpan.classList.toggle("session-preview", !!preview);
}

export {
  loadDirColors,
  getDirColor,
  displayPath,
  loadSessions,
  invalidateSidebar,
  updateTypingState,
  updateTypingPreview,
  showInlineSnapshot,
  removeInlineSnapshot,
  showSnapshotViewer,
  sessionFingerprint,
};
