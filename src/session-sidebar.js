// Session sidebar: directory colors, session list, context menu, snapshot viewer
import {
  state,
  dom,
  debugLog,
  STATUS_CLASSES,
  escapeHtml,
  showNotification,
  isUserActive,
  isBellMuted,
  toggleBellMuted,
} from "./renderer-state.js";
import { STATUS, INITIATOR } from "./session-statuses.js";
import {
  createDefaultLayout,
  TAB_EDITOR,
  TAB_SNAPSHOT,
  registerEditorTab,
} from "./dock-helpers.js";
import { createOverlayDialog, showConfirmDialog } from "./overlay-dialog.js";

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
  return `${s.sessionId}|${s.status}|${s.staleIdle ? "stale" : ""}|${s.intentionHeading || ""}|${s.intentionPreview || ""}|${s.cwd || ""}|${s.origin || ""}|${s.poolName || ""}|${s.parentSessionId || ""}`;
}

// Track previous session fingerprints for diff-based update
let prevSessionFingerprints = null;

// Play a short bell tone via Web Audio API
let bellCtx = null;
function playBell() {
  if (isBellMuted()) return;
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

// Track which parent sessions have their children expanded
const childrenExpanded = new Set();

// Current parent→children map (rebuilt on each loadSessions)
let childrenMap = new Map();

// Build a map of parentSessionId -> [child sessions] (recursive tree)
// Returns { childrenMap, topLevel set of sessionIds that have no visible parent }
function buildSessionTree(sessions) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const cMap = new Map(); // parentId -> [child sessions]
  const childIds = new Set();

  for (const s of sessions) {
    if (s.parentSessionId && byId.has(s.parentSessionId)) {
      childIds.add(s.sessionId);
      if (!cMap.has(s.parentSessionId)) {
        cMap.set(s.parentSessionId, []);
      }
      cMap.get(s.parentSessionId).push(s);
    }
  }

  return { childrenMap: cMap, childIds };
}

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

  // Build parent-child tree and filter children out of top-level sections
  const tree = buildSessionTree(sessions);
  childrenMap = tree.childrenMap;
  const { childIds } = tree;
  const isTopLevel = (s) => !childIds.has(s.sessionId);

  // Parents with non-archived children should stay in a non-archive section
  // even if the parent itself is archived/offloaded — keeps the tree visible.
  const hasNonArchivedChildren = (s) => {
    const children = childrenMap.get(s.sessionId);
    if (!children) return false;
    return children.some(
      (c) => c.status !== STATUS.ARCHIVED || hasNonArchivedChildren(c),
    );
  };

  // Split into sections — pool and external mixed together (top-level only)
  // Custom sessions stay in their own section only while fresh/typing (unused).
  // Once activated (processing/idle/etc.), they flow into normal sections.
  const custom = sessions.filter(
    (s) =>
      isTopLevel(s) &&
      s.origin === "custom" &&
      (s.status === STATUS.FRESH || s.status === STATUS.TYPING),
  );
  const customIds = new Set(custom.map((s) => s.sessionId));
  const notInCustom = (s) => !customIds.has(s.sessionId);
  const typing = sessions.filter(
    (s) => isTopLevel(s) && notInCustom(s) && s.status === STATUS.TYPING,
  );
  const recent = sessions.filter(
    (s) =>
      isTopLevel(s) &&
      notInCustom(s) &&
      (s.status === STATUS.IDLE ||
        s.status === STATUS.OFFLOADED ||
        // Archived/offloaded parents with alive children stay in Recent
        (s.status === STATUS.ARCHIVED && hasNonArchivedChildren(s))),
  );
  const processing = sessions.filter(
    (s) => isTopLevel(s) && notInCustom(s) && s.status === STATUS.PROCESSING,
  );
  const archived = sessions.filter(
    (s) =>
      isTopLevel(s) &&
      s.status === STATUS.ARCHIVED &&
      !hasNonArchivedChildren(s),
  );

  // Build fingerprint to check if anything changed
  const allItems = [
    ...custom,
    ...typing,
    ...recent,
    ...processing,
    ...archived,
  ];
  // Store section-ordered sessions for navigation (must match sidebar DOM order)
  state.sidebarSessions = allItems;
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

  // Bell when a session transitions to idle (finished processing).
  // Skip child sessions (model-initiated) — they shouldn't ring.
  // Suppress for the currently-viewed session if the window is focused
  // and the user has been active in the last 20 seconds.
  if (oldStatuses.size > 0) {
    let shouldBell = false;
    for (const s of sessions) {
      if (
        s.status === STATUS.IDLE &&
        s.initiator !== INITIATOR.MODEL &&
        oldStatuses.has(s.sessionId) &&
        oldStatuses.get(s.sessionId) !== STATUS.IDLE
      ) {
        const isViewing =
          s.sessionId === state.currentSessionId &&
          document.hasFocus() &&
          isUserActive();
        if (!isViewing) {
          shouldBell = true;
          break;
        }
      }
    }
    if (shouldBell) playBell();
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

  // Recursively count a session plus all its descendants
  function countWithChildren(s) {
    let count = 1;
    const children = childrenMap.get(s.sessionId);
    if (children) {
      for (const c of children) count += countWithChildren(c);
    }
    return count;
  }

  // Render a session item and its nested children (recursive)
  function appendSessionWithChildren(parent, s, depth) {
    parent.appendChild(createSessionItem(s, depth));
    const children = childrenMap.get(s.sessionId);
    if (!children || children.length === 0) return;

    const isExpanded = childrenExpanded.has(s.sessionId);
    if (!isExpanded) return;

    for (const child of children) {
      appendSessionWithChildren(parent, child, depth + 1);
    }
  }

  function addSection(label, items) {
    if (items.length === 0) return;
    // Count includes nested children
    let total = 0;
    for (const s of items) total += countWithChildren(s);
    const header = document.createElement("li");
    header.className = "session-section-header";
    header.textContent = `${label} (${total})`;
    dom.sessionList.appendChild(header);
    for (const s of items) {
      appendSessionWithChildren(dom.sessionList, s, 0);
    }
  }

  addSection("Custom", custom);
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
      appendSessionWithChildren(dom.sessionList, s, 0);
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

function createSessionItem(s, depth = 0) {
  const li = document.createElement("li");
  const isChild = depth > 0;
  li.className = `session-item${s.sessionId === state.currentSessionId ? " active" : ""}${s.status === STATUS.OFFLOADED || s.status === STATUS.ARCHIVED ? " offloaded" : ""}${isChild ? " session-child" : ""}`;
  li.dataset.sessionId = s.sessionId;
  if (isChild) li.style.paddingLeft = `${12 + depth * 18}px`;
  const heading = s.intentionHeading || s.intentionPreview || null;
  const isPreview = !s.intentionHeading && !!s.intentionPreview;
  const dp = displayPath(s);
  const dirColor = getDirColor(s);
  const indicatorStyle = dirColor
    ? `background: ${dirColor}; box-shadow: 0 0 4px ${dirColor}`
    : "background: transparent";
  const showOrigin =
    s.origin && s.status !== STATUS.OFFLOADED && s.status !== STATUS.ARCHIVED;
  const originLabel =
    s.origin === "pool" && s.poolName && s.poolName !== "default"
      ? s.poolName
      : s.origin;
  const originTag = showOrigin
    ? `<span class="session-origin-tag session-origin-${escapeHtml(s.origin)}">${escapeHtml(originLabel)}</span>`
    : "";
  const staleTag = s.staleIdle
    ? `<span class="session-origin-tag session-origin-stale">stale</span>`
    : "";
  const pinned = s.pinnedUntil && new Date(s.pinnedUntil) > new Date();
  const pinnedTag = pinned
    ? '<span class="session-origin-tag session-origin-pinned" title="Pinned — won\'t be offloaded">📌</span>'
    : "";

  // Children toggle for sessions that have children
  const hasChildren = childrenMap.has(s.sessionId);
  const isExpanded = childrenExpanded.has(s.sessionId);
  const toggleHtml = hasChildren
    ? `<span class="session-children-toggle">${isExpanded ? "▾" : "▸"}</span>`
    : "";

  li.innerHTML = `
    <div class="session-dir-indicator" style="${indicatorStyle}"></div>
    <div class="session-item-content">
      <div class="session-project">
        ${toggleHtml}
        <span class="session-status ${STATUS_CLASSES[s.status] || "dead"}"></span>
        <span class="session-title${isPreview ? " session-preview" : ""}">${escapeHtml(heading || "No intention yet")}</span>
        ${originTag}${staleTag}${pinnedTag}
      </div>
      <div class="session-cwd">${escapeHtml(dp)}</div>
    </div>
  `;

  // Toggle children expand/collapse on arrow click
  if (hasChildren) {
    const toggle = li.querySelector(".session-children-toggle");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleChildrenExpanded(s.sessionId);
    });
  }

  li.addEventListener("click", () => _actions.selectSession(s));
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showSessionContextMenu(e, s);
  });
  return li;
}

// Collect all descendant sessions depth-first (children's children first)
// Uses childrenMap for O(d) traversal instead of filtering all sessions per level
function getDescendantsDepthFirst(sessionId) {
  const children = childrenMap.get(sessionId) || [];
  const result = [];
  for (const child of children) {
    result.push(...getDescendantsDepthFirst(child.sessionId));
    result.push(child);
  }
  return result;
}

// Get all alive descendants (recursive) — used for archive guard + dialog count
function getAliveDescendants(sessionId) {
  const descendants = getDescendantsDepthFirst(sessionId);
  return descendants.filter((s) => s.alive);
}

// Archive with child check: warns if session has alive descendants, then
// delegates to server which cascade-archives all descendants depth-first.
async function archiveWithChildCheck(session) {
  const aliveDescendants = getAliveDescendants(session.sessionId);

  if (aliveDescendants.length > 0) {
    const confirmed = await showArchiveChildrenConfirm(
      session,
      aliveDescendants,
    );
    if (!confirmed) return;
  }

  try {
    await window.api.archiveSession(session.sessionId);
  } catch (err) {
    showNotification(`Archive failed: ${err.message}`);
  }
}

// Confirmation dialog for archiving a parent with alive descendants
function showArchiveChildrenConfirm(session, aliveDescendants) {
  const count = aliveDescendants.length;
  return showConfirmDialog({
    html: `
      <div class="snapshot-dialog" style="max-width: 400px;">
        <div class="snapshot-header">
          <span>Archive with children?</span>
          <button class="snapshot-close">\u2715</button>
        </div>
        <div style="padding: 16px; color: var(--text); font-size: 13px; line-height: 1.5;">
          <p style="margin: 0 0 12px;">
            <strong>${escapeHtml(session.intentionHeading || "This session")}</strong>
            has ${count} running descendant${count > 1 ? "s" : ""}.
          </p>
          <p style="margin: 0 0 16px; color: var(--text-dim);">
            All descendants will be archived first (deepest first).
          </p>
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button class="inline-snapshot-restart" style="background: var(--border);" data-action="cancel">Cancel</button>
            <button class="inline-snapshot-restart" data-action="confirm">Archive All</button>
          </div>
        </div>
      </div>
    `,
  });
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
      await archiveWithChildCheck(session);
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

// Show read-only transcript viewer
function showSnapshotViewer(session, transcriptText) {
  createOverlayDialog({
    id: "snapshot-viewer",
    html: `
      <div class="snapshot-dialog">
        <div class="snapshot-header">
          <span>${escapeHtml(session.intentionHeading || "Transcript")}</span>
          <button class="snapshot-close">\u2715</button>
        </div>
        <pre class="snapshot-content">${transcriptText ? escapeHtml(transcriptText) : "(no transcript available)"}</pre>
      </div>
    `,
  });
}

// Show session transcript inline as a dock tab for archived sessions
async function showInlineSnapshot(session, gen) {
  const btnLabel = "Resume";

  let transcriptText = null;
  try {
    transcriptText = await window.api.readSessionSnapshot(session.sessionId);
  } catch (err) {
    debugLog("session", `failed to read transcript: ${err.message}`);
  }
  if (gen !== state.sessionGeneration) return;

  const container = document.createElement("div");
  container.className = "dock-snapshot-content";
  container.innerHTML = `
    <div class="inline-snapshot-header">
      <span class="inline-snapshot-label">Archived Session</span>
      <button class="inline-snapshot-restart">${btnLabel}</button>
    </div>
    <pre class="snapshot-content inline-snapshot-content">${transcriptText ? escapeHtml(transcriptText) : "(no transcript available)"}</pre>
  `;

  container
    .querySelector(".inline-snapshot-restart")
    .addEventListener("click", async () => {
      try {
        await window.api.unarchiveSession(session.sessionId);
      } catch (err) {
        debugLog("session", `unarchive failed: ${err.message}`);
      }
      await _actions.resumeOffloadedSession(session);
    });

  // Register snapshot as a dock tab
  _actions.ensureEditorContainer();
  _actions.ensureDock();
  state.dock.registerTab(TAB_SNAPSHOT, {
    type: TAB_SNAPSHOT,
    label: "Archived",
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

// --- Children expand/collapse API ---

function toggleChildrenExpanded(sessionId) {
  if (childrenExpanded.has(sessionId)) {
    childrenExpanded.delete(sessionId);
  } else {
    childrenExpanded.add(sessionId);
  }
  invalidateSidebar();
}

function isChildrenExpanded(sessionId) {
  return childrenExpanded.has(sessionId);
}

function hasSessionChildren(sessionId) {
  return childrenMap.has(sessionId);
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
  toggleChildrenExpanded,
  isChildrenExpanded,
  hasSessionChildren,
  archiveWithChildCheck,
};
