// Renderer orchestrator: wires all modules together, handles session lifecycle and IPC events.

import {
  state,
  dom,
  debugLog,
  sessionTerminals,
  showNotification,
  showToast,
  toggleBellMuted,
  syncBellButton,
} from "./renderer-state.js";
import { STATUS, ORIGIN } from "./session-statuses.js";
import { disposeTerminalEntry } from "./dock-helpers.js";
import { createEditor, setOnDocChange } from "./editor.js";
import { createOverlayDialog } from "./overlay-dialog.js";
import {
  initSidebar,
  loadDirColors,
  getDirColor,
  displayPath,
  loadSessions,
  invalidateSidebar,
  updateTypingState,
  showInlineSnapshot,
  removeInlineSnapshot,
  toggleChildrenExpanded,
  isChildrenExpanded,
  hasSessionChildren,
  archiveWithChildCheck,
} from "./session-sidebar.js";
import {
  initTerminals,
  ensureEditorContainer,
  ensureDock,
  initDockLayout,
  syncSessionCache,
  spawnTerminal,
  attachPoolTerminal,
  switchToTerminal,
  closeTerminal,
  hideCurrentTerminals,
  restoreSessionTerminals,
  destroySessionTerminals,
  killAllTerminals,
  cleanupStaleTerminals,
  reconnectTerminal,
  reconnectAllPtys,
  focusTerminal,
  getActiveTermIndex,
  dockRegisterTerminal,
  cycleTabInFocusedLeaf,
  applyLayoutOrDefault,
  discoverExtraTerminals,
} from "./terminal-manager.js";
import { initPoolUi, showSettings, updatePoolHealthBadge } from "./pool-ui.js";
import { openSessionInfo } from "./stats-ui.js";
import {
  initCommandPalette,
  toggleCommandPalette,
  setShortcutConfig,
  COMMANDS,
  cyclePane,
  focusAdjacentPane,
  splitFocusedTab,
} from "./command-palette.js";
import { initSessionSearch, toggleSessionSearch } from "./session-search.js";

// --- Populate DOM refs ---
dom.sessionList = document.getElementById("session-list");
dom.refreshBtn = document.getElementById("refresh-btn");
dom.newSessionBtn = document.getElementById("new-session-btn");
dom.emptyState = document.getElementById("empty-state");
dom.sessionView = document.getElementById("session-view");
dom.dockContainer = document.getElementById("dock-container");
dom.sidebar = document.getElementById("sidebar");
dom.commandPalette = document.getElementById("command-palette");
dom.commandPaletteInput = document.getElementById("command-palette-input");
dom.commandPaletteList = document.getElementById("command-palette-list");
dom.sessionSearch = document.getElementById("session-search");
dom.sessionSearchInput = document.getElementById("session-search-input");
dom.sessionSearchList = document.getElementById("session-search-list");

// --- Focus management ---

function focusEditor() {
  if (state.editorView) state.editorView.focus();
}

function togglePaneFocus() {
  if (state.editorMount && state.editorMount.contains(document.activeElement)) {
    focusTerminal();
  } else {
    focusEditor();
  }
}

function toggleSidebar() {
  dom.sidebar.classList.toggle("collapsed");
}

// --- Session selection ---

async function selectSession(session) {
  // If already viewing this session, nothing to do
  if (session.sessionId === state.currentSessionId) return;

  hideCurrentTerminals();

  state.currentSessionId = session.sessionId;
  state.currentSessionCwd = session.cwd;
  const gen = ++state.sessionGeneration;
  debugLog(
    "session",
    `select ${session.sessionId} gen=${gen} origin=${session.origin}`,
  );

  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.sessionId === session.sessionId);
  });

  dom.emptyState.classList.add("hidden");
  dom.sessionView.classList.remove("hidden");

  // Ensure editor container exists
  ensureEditorContainer();
  state.editorProject.textContent = session.project
    ? `${session.project} — ${displayPath(session)}`
    : session.sessionId;

  // Apply directory color as border around all panes
  const dirColor = getDirColor(session);
  if (dirColor) {
    dom.sessionView.style.setProperty("--repo-color", dirColor);
    dom.sessionView.classList.add("colored");
  } else {
    dom.sessionView.classList.remove("colored");
  }

  // Offloaded/archived: show snapshot inline instead of a terminal
  if (
    session.status === STATUS.OFFLOADED ||
    session.status === STATUS.ARCHIVED
  ) {
    showInlineSnapshot(session, gen);
  } else if (!restoreSessionTerminals(session.sessionId)) {
    // No cached terminals — set up fresh dock + terminals
    initDockLayout();

    // Resolve the daemon terminal ID for pool/custom sessions
    let daemonTermId = null;
    if (session.origin === ORIGIN.POOL) {
      const pool = await window.api.poolRead();
      if (gen !== state.sessionGeneration) {
        debugLog("session", `race abort gen=${gen} at poolRead`);
        return;
      }
      const slot = pool?.slots.find((s) => s.sessionId === session.sessionId);
      daemonTermId = slot?.termId || null;
    } else if (session.origin === ORIGIN.CUSTOM) {
      const allPtys = await window.api.ptyList();
      if (gen !== state.sessionGeneration) {
        debugLog("session", `race abort gen=${gen} at customPtyList`);
        return;
      }
      const pty = allPtys.find(
        (p) => p.sessionId === session.sessionId && !p.exited,
      );
      daemonTermId = pty?.termId || null;
    }

    if (daemonTermId) {
      // Attach to existing daemon terminal (pool or custom)
      try {
        await attachPoolTerminal(daemonTermId);
        if (gen !== state.sessionGeneration) {
          debugLog("session", `race abort gen=${gen} at daemonAttach`);
          destroySessionTerminals(session.sessionId);
          return;
        }
      } catch {
        debugLog(
          "session",
          `attach failed for ${daemonTermId}, falling back to shell`,
        );
        await spawnTerminal(session.cwd);
        if (gen !== state.sessionGeneration) {
          debugLog("session", `race abort gen=${gen} at attachFallback`);
          destroySessionTerminals(session.sessionId);
          return;
        }
      }

      // Discover and attach any extra shell terminals (e.g. opened via API)
      try {
        await discoverExtraTerminals(session.sessionId, daemonTermId);
        if (gen !== state.sessionGeneration) {
          debugLog("session", `race abort gen=${gen} at extraPtyList`);
          destroySessionTerminals(session.sessionId);
          return;
        }
      } catch (err) {
        debugLog("session", `extra terminal discovery failed: ${err.message}`);
      }
    } else if (
      session.origin === ORIGIN.POOL ||
      session.origin === ORIGIN.CUSTOM
    ) {
      // Daemon session but no terminal found — fallback to shell
      await spawnTerminal(session.cwd);
      if (gen !== state.sessionGeneration) {
        debugLog("session", `race abort gen=${gen} at noTermSpawn`);
        destroySessionTerminals(session.sessionId);
        return;
      }
    } else {
      // External session: spawn a fresh shell
      await spawnTerminal(session.cwd);
      if (gen !== state.sessionGeneration) {
        debugLog("session", `race abort gen=${gen} at extSpawn`);
        destroySessionTerminals(session.sessionId);
        return;
      }
    }

    // Restore saved layout or fall back to default
    const savedLayout = await window.api.loadLayout(session.sessionId);
    applyLayoutOrDefault(savedLayout);
  }

  const content = await window.api.readIntention(session.sessionId);
  if (gen !== state.sessionGeneration) return;
  createEditor(content);
  if (state.saveStatus) state.saveStatus.textContent = "";

  await window.api.watchIntention(session.sessionId);
  if (gen !== state.sessionGeneration) return;

  // Auto-focus the Claude terminal so the user can type immediately
  focusTerminal();
}

// --- Pool slot acquisition ---

function isFreshPoolSlot(s) {
  return (
    s.origin === ORIGIN.POOL &&
    (s.status === STATUS.FRESH || s.poolStatus === STATUS.FRESH)
  );
}

// Acquire a fresh slot: prefer existing fresh, else offload LRU idle.
// Returns the fresh session object or null if pool is fully busy.
async function acquireFreshSlot() {
  const sessions = await window.api.getSessions();

  // 1. Prefer an existing fresh slot (poolStatus is set by main process)
  const freshSession = sessions.find(isFreshPoolSlot);
  if (freshSession) return freshSession;

  // No pool sessions at all — nothing to acquire from
  if (!sessions.some((s) => s.origin === ORIGIN.POOL)) return null;

  // 2. Offload the longest-unused idle session (LRU)
  const idleSessions = sessions
    .filter(
      (s) =>
        s.status === STATUS.IDLE &&
        s.origin === ORIGIN.POOL &&
        s.sessionId !== state.currentSessionId,
    )
    .sort((a, b) => a.idleTs - b.idleTs);

  if (idleSessions.length === 0) return null; // All slots busy — can't acquire

  const victim = idleSessions[0];

  // Find the victim's terminal from pool data (need termId for offload)
  const pool = await window.api.poolRead();
  const victimSlot = pool?.slots.find((s) => s.sessionId === victim.sessionId);
  if (!victimSlot) return null;

  try {
    await window.api.offloadSession(
      victim.sessionId,
      victimSlot.termId,
      victim.sessionId, // Claude session UUID = our session ID (same value from hook)
      { cwd: victim.cwd, gitRoot: victim.gitRoot, pid: victim.pid },
    );
  } catch (err) {
    debugLog("pool", `offload failed session=${victim.sessionId}`, err.message);
    return null;
  }

  // Poll until the slot becomes fresh (idle signal changes after /clear)
  debugLog(
    "pool",
    `polling for fresh slot after offload of ${victim.sessionId}`,
  );
  const fresh = await pollForFreshSlot(30000);
  if (fresh) {
    destroySessionTerminals(victim.sessionId, { keepAlive: true });
  }
  return fresh;
}

// Poll getSessions() until a fresh pool slot appears
async function pollForFreshSlot(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    const sessions = await window.api.getSessions();
    const fresh = sessions.find(isFreshPoolSlot);
    if (fresh) {
      debugLog("pool", `fresh slot found: ${fresh.sessionId}`);
      return fresh;
    }
  }
  debugLog("pool", `poll timed out after ${timeoutMs}ms — no fresh slot`);
  return null;
}

// --- Resume offloaded session ---

async function resumeOffloadedSession(session) {
  let result;
  try {
    result = await window.api.poolResume(session.sessionId);
    showNotification(`Resuming session in slot ${result.slotIndex}…`);
  } catch (err) {
    debugLog("pool", `resume failed session=${session.sessionId}`, err.message);
    showNotification(`Resume failed: ${err.message}`);
    return;
  }

  // Transition: cache previous session's terminals, set up fresh dock, attach terminal
  hideCurrentTerminals();
  // Clear currentSessionId so attachPoolTerminal → syncSessionCache() doesn't
  // cache the resumed terminal under the previously-viewed session's ID.
  state.currentSessionId = null;
  initDockLayout();

  try {
    await attachPoolTerminal(result.termId);
  } catch (err) {
    debugLog("pool", `attach after resume failed: ${err.message}`);
  }

  // Restore saved layout from the offloaded session, or use default
  const savedLayout = await window.api.loadLayout(session.sessionId);
  applyLayoutOrDefault(savedLayout);

  // Poll until the slot gets its new session ID, then update our state
  const oldSessionId = session.sessionId;
  const newSession = await pollForResumedSession(result.termId, 60000);
  if (newSession) {
    state.currentSessionId = newSession.sessionId;
    state.currentSessionCwd = newSession.cwd;

    // Clean up any renderer-side cached terminals for the old session
    // (e.g. from startup reconnect). The daemon terminals were re-tagged
    // to the new sessionId by main.js, so we just dispose the stale UI.
    // Skip terminals currently active in the dock — they were attached
    // during this resume and will be re-cached under the new session ID.
    const activeTermIds = new Set(state.terminals.map((t) => t.termId));
    const oldCached = sessionTerminals.get(oldSessionId);
    if (oldCached) {
      for (const entry of oldCached.terminals) {
        if (activeTermIds.has(entry.termId)) continue;
        window.api.ptyDetach(entry.termId).catch(() => {});
        disposeTerminalEntry(entry, state.dock);
      }
    }
    sessionTerminals.delete(oldSessionId);

    // Re-attach orphaned extra terminals from daemon (re-tagged by main.js)
    try {
      await discoverExtraTerminals(newSession.sessionId, result.termId);
    } catch (err) {
      debugLog("pool", `re-attach orphaned terminals failed: ${err.message}`);
    }

    if (state.terminals.length > 0) {
      sessionTerminals.set(newSession.sessionId, {
        terminals: [...state.terminals],
        dockLayout: state.dock ? state.dock.getLayout() : null,
        lastAccessed: Date.now(),
      });
    }

    // Reload intention file for the new session ID and update the watcher
    const content = await window.api.readIntention(newSession.sessionId);
    createEditor(content);
    await window.api.watchIntention(newSession.sessionId);
  }
  await loadSessions();
}

// Poll getSessions until we find the session in a given pool slot
async function pollForResumedSession(termId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    const pool = await window.api.poolRead();
    if (!pool) continue;
    const slot = pool.slots.find(
      (s) => s.termId === termId && s.status !== STATUS.FRESH,
    );
    if (slot?.sessionId) {
      const sessions = await window.api.getSessions();
      const match = sessions.find((s) => s.sessionId === slot.sessionId);
      if (match) return match;
    }
  }
  debugLog("pool", `poll for resumed session timed out after ${timeoutMs}ms`);
  return null;
}

// --- Auto-save ---

function scheduleSave() {
  if (!state.currentSessionId || !state.editorView) return;
  if (state.saveStatus) state.saveStatus.textContent = "Editing...";
  updateTypingState();
  clearTimeout(state.saveTimeout);
  state.saveTimeout = setTimeout(async () => {
    const content = state.editorView.state.doc.toString();
    try {
      await window.api.writeIntention(state.currentSessionId, content);
      if (state.saveStatus) state.saveStatus.textContent = "Saved";
      setTimeout(() => {
        if (state.saveStatus && state.saveStatus.textContent === "Saved")
          state.saveStatus.textContent = "";
      }, 2000);
    } catch (err) {
      debugLog(
        "editor",
        `intention save failed session=${state.currentSessionId}`,
        err.message,
      );
      if (state.saveStatus) state.saveStatus.textContent = "";
    }
  }, 500);
}

// --- Session tree helpers (shared by navigation functions) ---

function buildSessionMaps() {
  const byId = new Map(state.cachedSessions.map((s) => [s.sessionId, s]));
  const cMap = new Map();
  const childIds = new Set();
  for (const s of state.cachedSessions) {
    if (s.parentSessionId && byId.has(s.parentSessionId)) {
      childIds.add(s.sessionId);
      if (!cMap.has(s.parentSessionId)) cMap.set(s.parentSessionId, []);
      cMap.get(s.parentSessionId).push(s);
    }
  }
  return { byId, cMap, childIds };
}

// Build flat list matching visual sidebar order (parents with children grouped)
function buildVisualOrder({ cMap, childIds }) {
  const result = [];
  function addWithChildren(s) {
    result.push(s);
    const children = cMap.get(s.sessionId);
    if (children && isChildrenExpanded(s.sessionId)) {
      for (const child of children) addWithChildren(child);
    }
  }
  // Use sidebar's section-ordered list to match visual DOM order
  const source = state.sidebarSessions?.length
    ? state.sidebarSessions
    : state.cachedSessions;
  for (const s of source) {
    if (!childIds.has(s.sessionId)) addWithChildren(s);
  }
  return result;
}

// --- Session switching ---

function switchSession(direction) {
  // Navigate between visible sessions in visual (tree) order
  const maps = buildSessionMaps();
  const ordered = buildVisualOrder(maps);
  const navigable = ordered.filter(
    (s) =>
      (s.alive &&
        (s.status === STATUS.IDLE ||
          s.status === STATUS.PROCESSING ||
          s.status === STATUS.TYPING)) ||
      s.status === STATUS.ARCHIVED,
  );
  if (navigable.length === 0) return;
  const currentIndex = navigable.findIndex(
    (s) => s.sessionId === state.currentSessionId,
  );
  let nextIndex;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex =
      (currentIndex + direction + navigable.length) % navigable.length;
  }
  selectSession(navigable[nextIndex]);
}

// --- Child session navigation ---

function toggleChildren() {
  if (!state.currentSessionId) return;
  const current = state.cachedSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  if (!current) return;

  // If current session has children, toggle its expand/collapse
  if (hasSessionChildren(current.sessionId)) {
    toggleChildrenExpanded(current.sessionId);
    return;
  }

  // If current session is a child, toggle its parent's children
  if (current.parentSessionId && hasSessionChildren(current.parentSessionId)) {
    toggleChildrenExpanded(current.parentSessionId);
  }
}

function switchChildSession(direction) {
  if (!state.currentSessionId) return;
  const { byId, cMap } = buildSessionMaps();
  const current = byId.get(state.currentSessionId);
  if (!current) return;

  const expandAndSelect = (parentId, target) => {
    if (!isChildrenExpanded(parentId)) toggleChildrenExpanded(parentId);
    selectSession(target);
  };

  if (direction > 0) {
    // Down: if current has children, go deeper into first child
    const children = cMap.get(current.sessionId);
    if (children?.length) {
      expandAndSelect(current.sessionId, children[0]);
      return;
    }
    // Leaf node: walk up ancestors to find next sibling
    let node = current;
    while (node.parentSessionId) {
      const siblings = cMap.get(node.parentSessionId) || [];
      const idx = siblings.findIndex((s) => s.sessionId === node.sessionId);
      if (idx !== -1 && idx + 1 < siblings.length) {
        selectSession(siblings[idx + 1]);
        return;
      }
      node = byId.get(node.parentSessionId);
      if (!node) return;
    }
  } else {
    // Up: navigate to prev sibling or back to parent
    if (current.parentSessionId) {
      const siblings = cMap.get(current.parentSessionId) || [];
      const idx = siblings.findIndex((s) => s.sessionId === current.sessionId);
      if (idx > 0) {
        selectSession(siblings[idx - 1]);
      } else {
        const parent = byId.get(current.parentSessionId);
        if (parent) selectSession(parent);
      }
    } else {
      // On a top-level parent: go to last child
      const children = cMap.get(current.sessionId);
      if (children?.length) {
        expandAndSelect(current.sessionId, children[children.length - 1]);
      }
    }
  }
}

// --- Jump to most recent idle session ---

function jumpToRecentIdle() {
  const idle = state.cachedSessions.find(
    (s) =>
      s.status === STATUS.IDLE &&
      s.sessionId !== state.currentSessionId &&
      s.initiator !== "model",
  );
  if (idle) selectSession(idle);
}

// --- Focus external terminal for current session ---

async function focusCurrentExternalTerminal() {
  const session = state.cachedSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  if (!session || !session.alive || session.origin === ORIGIN.POOL) return;
  const result = await window.api.focusExternalTerminal(session.pid);
  if (result.focused) showNotification(`Focused ${result.app}`);
}

// --- Archive current session (then jump to recent idle) ---

async function archiveCurrentSession() {
  if (!state.currentSessionId) return;
  const session = state.cachedSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  if (!session) return;
  // Can't archive already-archived sessions
  if (session.status === STATUS.ARCHIVED) return;

  const archivingSessionId = state.currentSessionId;

  // Jump away immediately — don't wait for the slow offload+/clear
  const idle = state.cachedSessions.find(
    (s) =>
      s.sessionId !== archivingSessionId &&
      (s.status === STATUS.IDLE ||
        s.status === STATUS.FRESH ||
        s.status === STATUS.TYPING),
  );
  if (idle) {
    selectSession(idle);
  }

  if (session.origin === ORIGIN.CUSTOM && session.alive) {
    // Custom session: kill the daemon PTY (fully kill, not offload)
    const allPtys = await window.api.ptyList();
    const pty = allPtys.find(
      (p) => p.sessionId === session.sessionId && !p.exited,
    );
    if (pty) window.api.ptyKill(pty.termId).catch(() => {});
    destroySessionTerminals(session.sessionId);
  } else if (session.origin !== ORIGIN.POOL && session.alive && session.pid) {
    // External/sub-claude session: close external terminal
    window.api.closeExternalTerminal(session.pid).catch(() => {});
  }

  // Archive in background (with child check + confirmation if needed)
  await archiveWithChildCheck(session);
  await loadSessions();
}

// --- Setup script picker ---

function showSetupScriptPicker(scripts) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "setup-script-overlay";

    const dialog = document.createElement("div");
    dialog.className = "setup-script-dialog";

    const title = document.createElement("div");
    title.className = "setup-script-title";
    title.textContent = "Setup Script";
    dialog.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "setup-script-subtitle";
    subtitle.textContent = "Run a script in the new session";
    dialog.appendChild(subtitle);

    const list = document.createElement("div");
    list.className = "setup-script-list";

    let selectedIndex = 0;
    const items = [];

    // "None" option first
    const allOptions = ["None", ...scripts];

    for (let i = 0; i < allOptions.length; i++) {
      const item = document.createElement("div");
      item.className = "setup-script-item";
      if (i === 0) item.classList.add("selected");
      item.textContent = allOptions[i];
      item.addEventListener("click", () => {
        cleanup();
        resolve(i === 0 ? null : allOptions[i]);
      });
      list.appendChild(item);
      items.push(item);
    }

    dialog.appendChild(list);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function updateSelection() {
      items.forEach((el, i) =>
        el.classList.toggle("selected", i === selectedIndex),
      );
      items[selectedIndex].scrollIntoView({ block: "nearest" });
    }

    function cleanup() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    }

    function onKey(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % allOptions.length;
        updateSelection();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIndex =
          (selectedIndex - 1 + allOptions.length) % allOptions.length;
        updateSelection();
      } else if (e.key === "Enter") {
        e.preventDefault();
        cleanup();
        resolve(selectedIndex === 0 ? null : allOptions[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    }

    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    });
  });
}

async function typeSetupScript(termId, scriptContent) {
  // Each line is typed literally; \r in the text becomes a carriage return
  const processed = scriptContent.replace(/\\r/g, "\r");
  await window.api.ptyWrite(termId, processed);
}

// --- Initialize all modules ---

// Terminal manager
initTerminals({
  removeInlineSnapshot,
  displayPath,
  createEditor,
});

// Session sidebar
initSidebar({
  selectSession,
  resumeOffloadedSession,
  cleanupStaleTerminals,
  updatePoolHealthBadge,
  ensureEditorContainer,
  ensureDock,
});

// Pool UI
initPoolUi({
  loadSessions,
  focusTerminal,
  loadDirColors,
});

// Command palette
initCommandPalette({
  switchSession,
  spawnTerminal,
  spawnCustomSession,
  getActiveTermIndex,
  closeTerminal,
  switchToTerminal,
  cycleTabInFocusedLeaf,
  jumpToRecentIdle,
  archiveCurrentSession,
  toggleSidebar,
  togglePaneFocus,
  focusEditor,
  focusTerminal,
  focusCurrentExternalTerminal,
  loadDirColors,
  loadSessions,
  showSettings,
  toggleChildren,
  switchChildSession,
  openSessionInfo,
  openSessionSearch: toggleSessionSearch,
});

// Session search
initSessionSearch({
  selectSession,
  focusTerminal,
  displayPath,
});

// Editor doc change callback
setOnDocChange(scheduleSave);

// --- Button handlers ---

dom.refreshBtn.addEventListener("click", async () => {
  await loadDirColors();
  loadSessions();
});

let newSessionInProgress = false;
dom.newSessionBtn.addEventListener("click", async () => {
  if (newSessionInProgress) return;
  newSessionInProgress = true;
  try {
    // Check pool is initialized
    const pool = await window.api.poolRead();
    if (!pool) {
      showNotification("Pool not initialized — open pool settings");
      return;
    }

    // Check for setup scripts before acquiring a slot
    let selectedScript = null;
    const scripts = await window.api.listSetupScripts();
    if (scripts.length > 0) {
      selectedScript = await showSetupScriptPicker(scripts);
      // null means "None" or Escape — proceed without script
    }

    const freshSlot = await acquireFreshSlot();
    if (!freshSlot) {
      showNotification(
        "All pool slots are busy — wait for a session to finish or resize pool",
      );
      return;
    }

    await selectSession(freshSlot);

    // Type setup script into the session's terminal
    if (selectedScript) {
      const content = await window.api.readSetupScript(selectedScript);
      if (content) {
        const poolData = await window.api.poolRead();
        const slot = poolData?.slots.find(
          (s) => s.sessionId === freshSlot.sessionId,
        );
        if (slot) {
          await typeSetupScript(slot.termId, content);
        }
      }
    }

    await loadSessions();
  } finally {
    newSessionInProgress = false;
  }
});

// --- Custom session dialog ---

function showCustomSessionDialog() {
  return new Promise((resolve) => {
    let resolved = false;
    function finish(result) {
      if (resolved) return;
      resolved = true;
      window.api.setDialogOpen(false);
      close();
      resolve(result);
    }

    const { overlay, close } = createOverlayDialog({
      id: "custom-session-dialog",
      escapeClose: false,
      closeSelector: null,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          window.api.setDialogOpen(false);
          resolve(null);
        }
      },
      onKeydown(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const cwdInput = overlay.querySelector("#custom-session-cwd");
          const flagsInput = overlay.querySelector("#custom-session-flags");
          finish({
            cwd: cwdInput.value.trim() || "~",
            flags: flagsInput.value.trim(),
          });
        } else if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          const cwdInput = overlay.querySelector("#custom-session-cwd");
          const flagsInput = overlay.querySelector("#custom-session-flags");
          if (document.activeElement === cwdInput) flagsInput.focus();
          else cwdInput.focus();
        }
      },
      html: `
        <div class="custom-session-dialog">
          <div class="setup-script-title">New Custom Session</div>
          <div class="setup-script-subtitle">Spawn a standalone Claude session</div>
          <div class="field-group">
            <label>Working directory</label>
            <input type="text" id="custom-session-cwd" placeholder="~" value="~" />
          </div>
          <div class="field-group">
            <label>Extra flags (optional)</label>
            <input type="text" id="custom-session-flags" placeholder="e.g. --model sonnet" />
          </div>
          <div class="dialog-buttons">
            <button class="btn-cancel">Cancel</button>
            <button class="btn-spawn">Spawn</button>
          </div>
        </div>
      `,
    });

    window.api.setDialogOpen(true);

    const cwdInput = overlay.querySelector("#custom-session-cwd");
    const cancelBtn = overlay.querySelector(".btn-cancel");
    const spawnBtn = overlay.querySelector(".btn-spawn");

    cwdInput.focus();
    cwdInput.select();

    cancelBtn.addEventListener("click", () => finish(null));
    spawnBtn.addEventListener("click", () => {
      const cwd = overlay.querySelector("#custom-session-cwd");
      const flags = overlay.querySelector("#custom-session-flags");
      finish({
        cwd: cwd.value.trim() || "~",
        flags: flags.value.trim(),
      });
    });
  });
}

let customSessionInProgress = false;
async function spawnCustomSession() {
  if (customSessionInProgress) return;
  customSessionInProgress = true;
  try {
    const result = await showCustomSessionDialog();
    if (!result) return;

    const { cwd, flags } = result;
    showNotification("Spawning custom session…");

    const { termId, pid } = await window.api.spawnCustomSession(cwd, flags);

    // Wait for the session to register (plugin hook writes session-pids/<PID>)
    const sessionId = await window.api.ptyWaitSession(pid);
    if (!sessionId) {
      showNotification("Custom session failed to register");
      return;
    }

    // Tag the daemon terminal with the session ID
    await window.api.ptySetSession(termId, sessionId);

    // Refresh session list and select the new session
    await loadSessions();
    const newSession = state.cachedSessions.find(
      (s) => s.sessionId === sessionId,
    );
    if (newSession) {
      await selectSession(newSession);
    }
  } catch (err) {
    showNotification(`Custom session failed: ${err.message}`);
  } finally {
    customSessionInProgress = false;
  }
}

// --- IPC event handlers ---

// Menu keyboard shortcuts — terminal tabs
window.api.onNewTerminalTab(() => {
  if (state.currentSessionId) spawnTerminal(state.currentSessionCwd);
});

window.api.onCloseTerminalTab(() => {
  const popup = document.getElementById("slot-terminal-popup");
  if (popup && popup._cleanup) {
    popup._cleanup();
    return;
  }
  const i = getActiveTermIndex();
  if (i >= 0) closeTerminal(i);
});

window.api.onNextTerminalTab(() => cycleTabInFocusedLeaf(1));

window.api.onPrevTerminalTab(() => cycleTabInFocusedLeaf(-1));

window.api.onSwitchTerminalTab((index) => {
  if (index < state.terminals.length) switchToTerminal(index);
});

// Navigation shortcuts
window.api.onNewSession(() => dom.newSessionBtn.click());
window.api.onNewCustomSession(spawnCustomSession);
window.api.onNextSession(() => switchSession(1));
window.api.onPrevSession(() => switchSession(-1));
window.api.onToggleChildren(toggleChildren);
window.api.onNextChildSession(() => switchChildSession(1));
window.api.onPrevChildSession(() => switchChildSession(-1));
window.api.onToggleSidebar(toggleSidebar);
window.api.onFocusEditor(focusEditor);
window.api.onFocusTerminal(() => {
  // Don't steal focus from command palette (Escape closes it instead)
  if (!dom.commandPalette.classList.contains("visible")) focusTerminal();
});
window.api.onToggleCommandPalette(toggleCommandPalette);
window.api.onTogglePaneFocus(togglePaneFocus);
window.api.onCyclePane(cyclePane);
window.api.onFocusNextPane(() => focusAdjacentPane(1));
window.api.onFocusPrevPane(() => focusAdjacentPane(-1));
window.api.onSplitRight(() => splitFocusedTab("right"));
window.api.onSplitDown(() => splitFocusedTab("down"));
window.api.onFocusExternalTerminal(focusCurrentExternalTerminal);
window.api.onJumpRecentIdle(jumpToRecentIdle);
window.api.onArchiveCurrentSession(archiveCurrentSession);
window.api.onOpenInCursor(() => {
  if (state.currentSessionCwd) window.api.openInCursor(state.currentSessionCwd);
});
window.api.onOpenPoolSettings(() => showSettings());
window.api.onOpenSessionInfo(() => openSessionInfo());
window.api.onToggleBell(toggleBellMuted);
window.api.onSessionSearch(toggleSessionSearch);

// Bell toggle button
document
  .getElementById("bell-toggle-btn")
  .addEventListener("click", toggleBellMuted);
syncBellButton();

// Pool slot recovery toast
window.api.onPoolSlotsRecovered((slots) => {
  const reasons = slots.map((s) => `slot ${s.index} (${s.reason})`).join(", ");
  const msg = `Auto-recovered ${slots.length} pool slot${slots.length > 1 ? "s" : ""}: ${reasons}`;
  debugLog("pool", msg);
  showToast(msg, "warning");
});

// Plugin version mismatch check (non-blocking toast)
(async () => {
  try {
    const [appVersion, pluginVersion, seen] = await Promise.all([
      window.api.getAppVersion(),
      window.api.getPluginVersion(),
      window.api.getSeenPluginVersion(),
    ]);
    if (
      window.api.isPluginVersionMismatch(pluginVersion, appVersion) &&
      seen !== pluginVersion
    ) {
      showToast(
        `Plugin version (${pluginVersion}) differs from app (${appVersion}). ` +
          `Plugin will auto-update soon. Re-init pool after update to pick up new hooks.`,
        "warning",
      );
      window.api.markPluginVersionSeen(pluginVersion);
    }
  } catch {
    // Non-critical — skip silently
  }
})();

// Handle external file changes
window.api.onIntentionChanged((content) => {
  if (!state.editorView) return;
  const current = state.editorView.state.doc.toString();
  if (content !== current) {
    state.editorView.dispatch({
      changes: { from: 0, to: current.length, insert: content },
    });
    if (state.saveStatus) state.saveStatus.textContent = "Updated from disk";
    setTimeout(() => {
      if (
        state.saveStatus &&
        state.saveStatus.textContent === "Updated from disk"
      )
        state.saveStatus.textContent = "";
    }, 2000);
  }
});

// --- Startup ---

loadDirColors().then(async () => {
  // Load shortcut config for command palette display
  try {
    const shortcuts = await window.api.getShortcuts();
    setShortcutConfig(shortcuts);
  } catch {}

  await reconnectAllPtys();
  const POLL_INTERVAL = 30000; // Safety net — events handle normal refresh
  let sessionPollInterval = setInterval(loadSessions, POLL_INTERVAL);
  loadSessions();

  // Event-driven refresh: main process pushes (already debounced) when
  // idle-signals/session-pids change. Reset poll timer on each event since
  // polling only needs to kick in when events stop working.
  window.api.onSessionsChanged(() => {
    loadSessions();
    clearInterval(sessionPollInterval);
    sessionPollInterval = setInterval(loadSessions, POLL_INTERVAL);
  });

  // Pause polling when window is hidden to save CPU
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(sessionPollInterval);
      sessionPollInterval = null;
    } else {
      if (!sessionPollInterval) {
        loadSessions();
        sessionPollInterval = setInterval(loadSessions, POLL_INTERVAL);
      }
    }
  });
});
