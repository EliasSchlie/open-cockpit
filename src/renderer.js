// Renderer orchestrator: wires all modules together, handles session lifecycle and IPC events.

import {
  state,
  dom,
  debugLog,
  sessionTerminals,
  showNotification,
  showToast,
} from "./renderer-state.js";
import { STATUS } from "./session-statuses.js";
import {
  createDefaultLayout,
  TAB_EDITOR,
  disposeTerminalEntry,
} from "./dock-helpers.js";
import { createEditor, setOnDocChange } from "./editor.js";
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
} from "./terminal-manager.js";
import {
  initPoolUi,
  showPoolSettings,
  updatePoolHealthBadge,
  showShortcutSettings,
} from "./pool-ui.js";
import {
  initCommandPalette,
  toggleCommandPalette,
  setShortcutConfig,
  COMMANDS,
  cyclePane,
  focusAdjacentPane,
  splitFocusedTab,
} from "./command-palette.js";

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

  // Apply directory color to editor header
  const dirColor = getDirColor(session);
  const header = state.editorContainer.querySelector(".dock-editor-header");
  const existingBar = header.querySelector(".dock-editor-header-color-bar");
  if (existingBar) existingBar.remove();
  if (dirColor) {
    const colorBar = document.createElement("div");
    colorBar.className = "dock-editor-header-color-bar";
    colorBar.style.background = dirColor;
    colorBar.style.boxShadow = `0 0 8px ${dirColor}`;
    header.appendChild(colorBar);
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

    if (session.origin === "pool") {
      // Pool session: attach to the pool slot's existing Claude TUI
      const pool = await window.api.poolRead();
      if (gen !== state.sessionGeneration) {
        debugLog("session", `race abort gen=${gen} at poolRead`);
        return;
      }
      const slot = pool?.slots.find((s) => s.sessionId === session.sessionId);
      if (slot) {
        try {
          await attachPoolTerminal(slot.termId);
          if (gen !== state.sessionGeneration) {
            debugLog("session", `race abort gen=${gen} at poolAttach`);
            destroySessionTerminals(session.sessionId);
            return;
          }
        } catch {
          debugLog(
            "session",
            `pool attach failed for slot ${slot.termId}, falling back to shell`,
          );
          await spawnTerminal(session.cwd);
          if (gen !== state.sessionGeneration) {
            debugLog("session", `race abort gen=${gen} at spawnFallback`);
            destroySessionTerminals(session.sessionId);
            return;
          }
        }
      } else {
        await spawnTerminal(session.cwd);
        if (gen !== state.sessionGeneration) {
          debugLog("session", `race abort gen=${gen} at noSlotSpawn`);
          destroySessionTerminals(session.sessionId);
          return;
        }
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

    // Set the default dock layout
    const termTabIds = state.terminals.map((t) => t.dockTabId);
    state.dock.setLayout(createDefaultLayout(termTabIds, [TAB_EDITOR]));
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
    s.origin === "pool" &&
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
  if (!sessions.some((s) => s.origin === "pool")) return null;

  // 2. Offload the longest-unused idle session (LRU)
  const idleSessions = sessions
    .filter(
      (s) =>
        s.status === STATUS.IDLE &&
        s.origin === "pool" &&
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
  initDockLayout();

  try {
    await attachPoolTerminal(result.termId);
  } catch (err) {
    debugLog("pool", `attach after resume failed: ${err.message}`);
  }

  // Set dock layout after terminal is attached
  const termTabIds = state.terminals.map((t) => t.dockTabId);
  state.dock.setLayout(createDefaultLayout(termTabIds, [TAB_EDITOR]));

  // Poll until the slot gets its new session ID, then update our state
  const oldSessionId = session.sessionId;
  const newSession = await pollForResumedSession(result.termId, 60000);
  if (newSession) {
    state.currentSessionId = newSession.sessionId;
    state.currentSessionCwd = newSession.cwd;

    // Clean up any renderer-side cached terminals for the old session
    // (e.g. from startup reconnect). The daemon terminals were re-tagged
    // to the new sessionId by main.js, so we just dispose the stale UI.
    const oldCached = sessionTerminals.get(oldSessionId);
    if (oldCached) {
      for (const entry of oldCached.terminals) {
        window.api.ptyDetach(entry.termId).catch(() => {});
        disposeTerminalEntry(entry, state.dock);
      }
    }
    sessionTerminals.delete(oldSessionId);

    // Re-attach orphaned extra terminals from daemon (re-tagged by main.js)
    try {
      const allPtys = await window.api.ptyList();
      const extraPtys = allPtys.filter(
        (p) =>
          p.sessionId === newSession.sessionId &&
          !p.exited &&
          p.termId !== result.termId,
      );
      for (const p of extraPtys) {
        const entry = await reconnectTerminal(p);
        state.terminals.push(entry);
        dockRegisterTerminal(entry);
        if (state.dock) {
          const tuiTab = state.terminals.find((t) => t.isPoolTui)?.dockTabId;
          const leaf =
            (tuiTab && state.dock.getTabLeafId(tuiTab)) ||
            state.dock.getFirstLeafId();
          state.dock.addTab(entry.dockTabId, leaf);
        }
      }
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
    await new Promise((r) => setTimeout(r, 1000));
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

// --- Session switching ---

function switchSession(direction) {
  // Navigate between loaded sessions (idle + processing + typing), skip offloaded/fresh/dead
  const navigable = state.cachedSessions.filter(
    (s) =>
      s.alive &&
      (s.status === STATUS.IDLE ||
        s.status === STATUS.PROCESSING ||
        s.status === STATUS.TYPING),
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

// --- Jump to most recent idle session ---

function jumpToRecentIdle() {
  const idle = state.cachedSessions.find(
    (s) => s.status === STATUS.IDLE && s.sessionId !== state.currentSessionId,
  );
  if (idle) selectSession(idle);
}

// --- Focus external terminal for current session ---

async function focusCurrentExternalTerminal() {
  const session = state.cachedSessions.find(
    (s) => s.sessionId === state.currentSessionId,
  );
  if (!session || !session.alive || session.origin === "pool") return;
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

  // Archive in background
  try {
    await window.api.archiveSession(archivingSessionId);
  } catch (err) {
    console.error("Failed to archive session:", err);
  }
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
  COMMANDS,
});

// Command palette
initCommandPalette({
  switchSession,
  spawnTerminal,
  getActiveTermIndex,
  closeTerminal,
  switchToTerminal,
  jumpToRecentIdle,
  archiveCurrentSession,
  toggleSidebar,
  togglePaneFocus,
  focusEditor,
  focusTerminal,
  focusCurrentExternalTerminal,
  loadDirColors,
  loadSessions,
  showPoolSettings,
  showShortcutSettings,
});

// Editor doc change callback
setOnDocChange(scheduleSave);

// --- Button handlers ---

dom.refreshBtn.addEventListener("click", async () => {
  await loadDirColors();
  loadSessions();
});

dom.newSessionBtn.addEventListener("click", async () => {
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
});

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

window.api.onNextTerminalTab(() => {
  if (state.terminals.length > 1) {
    switchToTerminal((getActiveTermIndex() + 1) % state.terminals.length);
  }
});

window.api.onPrevTerminalTab(() => {
  if (state.terminals.length > 1) {
    switchToTerminal(
      (getActiveTermIndex() - 1 + state.terminals.length) %
        state.terminals.length,
    );
  }
});

window.api.onSwitchTerminalTab((index) => {
  if (index < state.terminals.length) switchToTerminal(index);
});

// Navigation shortcuts
window.api.onNewSession(() => dom.newSessionBtn.click());
window.api.onNextSession(() => switchSession(1));
window.api.onPrevSession(() => switchSession(-1));
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
window.api.onOpenPoolSettings(() => showPoolSettings());

// Pool slot recovery toast
window.api.onPoolSlotsRecovered((slots) => {
  const reasons = slots.map((s) => `slot ${s.index} (${s.reason})`).join(", ");
  const msg = `Auto-recovered ${slots.length} pool slot${slots.length > 1 ? "s" : ""}: ${reasons}`;
  debugLog("pool", msg);
  showToast(msg, "warning");
});

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
