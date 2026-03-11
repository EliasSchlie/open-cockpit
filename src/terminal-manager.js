// Terminal management: creation, attach, switch, close, caching, reconnect, IPC handlers
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  state,
  dom,
  debugLog,
  sessionTerminals,
  CLEANUP_AFTER_MS,
} from "./renderer-state.js";
import {
  DockLayout,
  createDefaultLayout,
  TAB_EDITOR,
  createEditorContainer,
  registerTerminalTab,
  registerEditorTab,
  setupTerminalResize,
  teardownTerminalResize,
  disposeTerminalEntry,
  getFocusedTabId,
  focusLeafContent,
} from "./dock-helpers.js";

// --- Cross-module dependencies (set via initTerminals) ---
let _actions = {};

export function initTerminals(actions) {
  _actions = actions;
}

// --- xterm.js theme (minimal — let shell theme handle ANSI colors) ---
const TERM_THEME = {
  background: "#0a0a0a",
};

export function createTerminal(extraOpts = {}) {
  return new Terminal({
    theme: TERM_THEME,
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: false,
    macOptionIsMeta: true,
    ...extraOpts,
  });
}

// xterm.js sends \r for both Enter and Shift+Enter (ignores shift modifier).
// Claude Code expects CSI u encoding (\x1b[13;2u) for Shift+Enter to trigger
// multi-line input. This handler intercepts modified Enter and sends the correct
// escape sequence directly to the PTY.
export function wireTerminalInput(term, termId) {
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.key !== "Enter") return true;
    if (!ev.shiftKey && !ev.ctrlKey) return true; // plain Enter or Alt+Enter: let xterm handle
    // Must return false for ALL event types (keydown, keypress, keyup) to fully
    // block xterm.js — otherwise keypress also sends \r alongside the CSI u.
    if (ev.type === "keydown") {
      const mod =
        (ev.shiftKey ? 1 : 0) | (ev.altKey ? 2 : 0) | (ev.ctrlKey ? 4 : 0);
      window.api.ptyWrite(termId, `\x1b[13;${mod + 1}u`);
    }
    return false;
  });
  term.onData((data) => window.api.ptyWrite(termId, data));
}

// Temporary lookup for terminals being reconnected (before they're in sessionTerminals)
export const pendingTerminals = new Map(); // termId -> entry
export const popupTerminals = new Map(); // termId -> { term, ... } for slot terminal popups

export function findTerminalEntry(termId) {
  const active = state.terminals.find((t) => t.termId === termId);
  if (active) return active;
  for (const cached of sessionTerminals.values()) {
    const entry = cached.terminals.find((t) => t.termId === termId);
    if (entry) return entry;
  }
  return pendingTerminals.get(termId) || null;
}

// Derive active terminal index from the focused (or last-focused) leaf
export function getActiveTermIndex() {
  if (!state.dock || state.terminals.length === 0) return -1;
  const focusedTabId = getFocusedTabId(state.dock, dom.dockContainer);
  if (focusedTabId) {
    const idx = state.terminals.findIndex((t) => t.dockTabId === focusedTabId);
    if (idx !== -1) return idx;
  }
  return -1;
}

// --- Dock helpers ---

export function ensureEditorContainer() {
  if (state.editorContainer) return;
  const result = createEditorContainer();
  state.editorContainer = result.editorContainer;
  state.editorMount = result.editorMount;
  state.editorProject = result.editorProject;
  state.saveStatus = result.saveStatus;
}

export function ensureDock() {
  if (state.dock) state.dock.destroy();
  state.dock = new DockLayout(dom.dockContainer, {
    onTabClose: (tabId) => {
      const entry = state.terminals.find((t) => t.dockTabId === tabId);
      if (entry) {
        const idx = state.terminals.indexOf(entry);
        if (idx !== -1) closeTerminal(idx);
      }
    },
    onTabActivate: (tabId) => {
      // Focus the activated tab's content — resize is handled by dock-resize event
      const entry = state.terminals.find((t) => t.dockTabId === tabId);
      if (entry) {
        entry.term.focus();
      }
      if (tabId === TAB_EDITOR && state.editorView) {
        state.editorView.focus();
      }
    },
    onNewTerminal: (leafId) => {
      if (state.currentSessionId)
        spawnTerminal(state.currentSessionCwd, null, null, leafId);
    },
    onLayoutChange: () => {
      syncSessionCache();
    },
  });
}

export function dockRegisterTerminal(entry) {
  if (!state.dock) return;
  const label = entry.isPoolTui ? "Claude" : `Terminal ${++state.shellCounter}`;
  registerTerminalTab(state.dock, entry, label);
}

// Remove references to unregistered tabs from a layout tree.
// Returns the pruned layout, or null if the entire tree is empty.
function sanitizeLayout(layout, registeredTabs) {
  if (!layout) return null;
  if (layout.type === "leaf") {
    const validTabs = layout.tabs.filter((id) => registeredTabs.has(id));
    if (validTabs.length === 0) return null;
    return {
      ...layout,
      tabs: validTabs,
      activeTab: Math.min(layout.activeTab, validTabs.length - 1),
    };
  }
  // split node
  const children = layout.children
    .map((c) => sanitizeLayout(c, registeredTabs))
    .filter(Boolean);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sizes = children.map(
    (_, i) => layout.sizes[i] ?? 100 / children.length,
  );
  // Renormalize sizes if children were removed
  if (children.length !== layout.children.length) {
    const total = sizes.reduce((a, b) => a + b, 0);
    for (let i = 0; i < sizes.length; i++) sizes[i] = (sizes[i] / total) * 100;
  }
  return { ...layout, children, sizes };
}

export { sanitizeLayout };

// Apply a saved layout (sanitized) or fall back to the default two-pane split.
export function applyLayoutOrDefault(savedLayout) {
  const sanitized = savedLayout && sanitizeLayout(savedLayout, state.dock.tabs);
  if (sanitized) {
    state.dock.setLayout(sanitized);
  } else {
    const termTabIds = state.terminals.map((t) => t.dockTabId);
    state.dock.setLayout(createDefaultLayout(termTabIds, [TAB_EDITOR]));
  }
}

// Initialize dock with optional existing terminals and saved layout.
// If no terminals/layout provided, caller adds tabs and sets layout after.
export function initDockLayout(existingTerminals, savedLayout) {
  ensureEditorContainer();
  ensureDock();
  state.shellCounter = 0;
  if (existingTerminals) {
    for (const t of existingTerminals) dockRegisterTerminal(t);
  }
  registerEditorTab(state.dock, state.editorContainer);
  if (savedLayout || (existingTerminals && existingTerminals.length > 0)) {
    applyLayoutOrDefault(savedLayout);
  }
}

// Debounced layout persistence — avoids excessive disk writes during resize drags
let _layoutSaveTimer = null;
let _pendingLayout = null;
let _pendingSessionId = null;

function scheduleLayoutSave(sessionId, layout) {
  _pendingLayout = layout;
  _pendingSessionId = sessionId;
  clearTimeout(_layoutSaveTimer);
  _layoutSaveTimer = setTimeout(() => {
    _layoutSaveTimer = null;
    _pendingLayout = null;
    _pendingSessionId = null;
    window.api.saveLayout(sessionId, layout);
  }, 500);
}

// Sync current terminals into the session cache (renderer + main process)
export function syncSessionCache() {
  if (!state.currentSessionId) return;
  const layout = state.dock ? state.dock.getLayout() : null;
  if (state.terminals.length === 0) {
    sessionTerminals.delete(state.currentSessionId);
  } else {
    sessionTerminals.set(state.currentSessionId, {
      terminals: [...state.terminals],
      dockLayout: layout,
      lastAccessed: Date.now(),
    });
    // Keep main process metadata in sync
    for (const t of state.terminals) {
      window.api.ptySetSession(t.termId, state.currentSessionId);
    }
  }
  // Persist layout to disk (debounced, fire-and-forget)
  if (layout) {
    scheduleLayoutSave(state.currentSessionId, layout);
  }
}

// --- Terminal lifecycle ---

export async function spawnTerminal(cwd, cmd, args, targetLeafId) {
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;";

  const term = createTerminal();

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  let termId, pid;
  try {
    ({ termId, pid } = await window.api.ptySpawn({
      cwd: cwd || undefined,
      cmd: cmd || undefined,
      args: args || undefined,
      sessionId: state.currentSessionId || undefined,
    }));
  } catch (err) {
    term.dispose();
    container.remove();
    throw err;
  }

  const entry = {
    termId,
    pid,
    term,
    fitAddon,
    container,
    isPoolTui: false,
    dockTabId: null,
    _resizeHandler: null,
  };
  state.terminals.push(entry);

  // Register before attach so replay/data can find this terminal
  pendingTerminals.set(termId, entry);
  try {
    await window.api.ptyAttach(termId);
  } catch (err) {
    debugLog("term", `attach failed termId=${termId}`, err.message);
    const idx = state.terminals.indexOf(entry);
    if (idx !== -1) state.terminals.splice(idx, 1);
    term.dispose();
    container.remove();
    pendingTerminals.delete(termId);
    throw err;
  }
  pendingTerminals.delete(termId);

  wireTerminalInput(term, termId);
  setupTerminalResize(entry);

  // Register with dock
  dockRegisterTerminal(entry);
  if (state.dock) {
    // Add to target leaf, or focused leaf, or first leaf
    const focusedLeaf = getFocusedLeafId();
    const leaf = targetLeafId || focusedLeaf || state.dock.getFirstLeafId();
    state.dock.addTab(entry.dockTabId, leaf);
  }

  // Focus the new terminal so user can type immediately
  entry.term.focus();

  syncSessionCache();
  return entry;
}

// Attach to an existing pool slot's PTY (no spawn — the Claude TUI is already running)
export async function attachPoolTerminal(poolTermId) {
  // Fetch the PTY's current dimensions so we can create xterm at the same size.
  // This prevents xterm.js reflow garbling when the replay buffer is written:
  // the buffer was rendered at these dimensions, so writing to a matching-size
  // terminal produces correct output. FitAddon later resizes to window dims.
  const allPtys = await window.api.ptyList();
  const ptyInfo = allPtys.find((p) => p.termId === poolTermId);

  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;";

  const term = createTerminal({
    ...(ptyInfo?.cols && { cols: ptyInfo.cols }),
    ...(ptyInfo?.rows && { rows: ptyInfo.rows }),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Write the buffer directly at matching dimensions (no reflow).
  // Then skip the daemon's replay event to avoid writing it twice.
  if (ptyInfo?.buffer) {
    term.write(ptyInfo.buffer);
  }

  const entry = {
    termId: poolTermId,
    pid: ptyInfo?.pid || null,
    term,
    fitAddon,
    container,
    isPoolTui: true,
    skipReplay: !!ptyInfo?.buffer,
    dockTabId: null,
    _resizeHandler: null,
  };
  state.terminals.push(entry);

  // Register before attach so data events can find this terminal
  pendingTerminals.set(poolTermId, entry);
  try {
    await window.api.ptyAttach(poolTermId);
  } catch (err) {
    debugLog("pool", `attach failed poolTermId=${poolTermId}`, err.message);
    const idx = state.terminals.indexOf(entry);
    if (idx !== -1) state.terminals.splice(idx, 1);
    term.dispose();
    container.remove();
    pendingTerminals.delete(poolTermId);
    throw err;
  }
  pendingTerminals.delete(poolTermId);

  wireTerminalInput(term, poolTermId);
  setupTerminalResize(entry);

  // Register with dock
  dockRegisterTerminal(entry);
  if (state.dock) {
    const leaf = state.dock.getFirstLeafId();
    state.dock.addTab(entry.dockTabId, leaf);
  }

  // Focus the new terminal so user can type immediately
  entry.term.focus();

  syncSessionCache();
  return entry;
}

export function switchToTerminal(index) {
  if (index < 0 || index >= state.terminals.length) return;
  const entry = state.terminals[index];
  if (entry.dockTabId && state.dock) {
    state.dock.activateTab(entry.dockTabId);
  }
}

// Cycle to the next/prev tab within the focused pane.
function getFocusedLeafId() {
  if (!state.dock) return null;
  const focusedTabId = getFocusedTabId(state.dock, dom.dockContainer);
  if (!focusedTabId) return null;
  return state.dock.getTabLeafId(focusedTabId);
}

// When at the boundary, crosses to the adjacent pane.
// direction: +1 for next, -1 for previous.
export function cycleTabInFocusedLeaf(direction) {
  const leafId = getFocusedLeafId();
  if (!leafId) return;

  const info = state.dock.getLeafTabInfo(leafId);
  if (!info) return;

  // Check if we're at the boundary of this leaf
  const atEnd = direction > 0 && info.activeTab >= info.tabs.length - 1;
  const atStart = direction < 0 && info.activeTab <= 0;

  if (atEnd || atStart) {
    // Jump to adjacent pane
    const leafIds = state.dock.getLeafIds();
    if (leafIds.length < 2) {
      // Only one pane — wrap within it
      state.dock.cycleTabInLeaf(leafId, direction);
      return;
    }
    const idx = leafIds.indexOf(leafId);
    const nextLeafIdx = (idx + direction + leafIds.length) % leafIds.length;
    const nextLeafId = leafIds[nextLeafIdx];
    // Activate the first or last tab in the target leaf depending on direction
    const nextInfo = state.dock.getLeafTabInfo(nextLeafId);
    if (nextInfo && nextInfo.tabs.length > 0) {
      const targetTab =
        direction > 0
          ? nextInfo.tabs[0]
          : nextInfo.tabs[nextInfo.tabs.length - 1];
      state.dock.activateTab(targetTab);
    }
  } else {
    state.dock.cycleTabInLeaf(leafId, direction);
  }
}

export async function closeTerminal(index) {
  if (index < 0 || index >= state.terminals.length) return;

  const entry = state.terminals[index];
  if (entry.isPoolTui) return; // Can't close the main Claude terminal

  // Remember which leaf this tab is in before removing it — after unregisterTab
  // the tab is gone from the tree, so we can't look it up anymore.
  const closedLeafId = state.dock
    ? state.dock.getTabLeafId(entry.dockTabId)
    : null;

  await window.api.ptyDetach(entry.termId).catch(() => {});
  await window.api.ptyKill(entry.termId);
  disposeTerminalEntry(entry, state.dock);
  state.terminals.splice(index, 1);

  if (state.terminals.length === 0) {
    dom.sessionView.classList.add("hidden");
    dom.emptyState.classList.remove("hidden");
  } else {
    // Focus the tab that's now active in the same leaf (dock already adjusted
    // activeTab index). Falls back to focusTerminal() if the leaf collapsed.
    const focused =
      state.dock && closedLeafId && focusLeafContent(state.dock, closedLeafId);
    if (!focused) focusTerminal();
  }

  syncSessionCache();
}

// Flush any pending debounced layout save immediately
export function flushLayoutSave() {
  if (!_layoutSaveTimer) return; // nothing pending
  clearTimeout(_layoutSaveTimer);
  _layoutSaveTimer = null;
  if (_pendingSessionId && _pendingLayout) {
    window.api.saveLayout(_pendingSessionId, _pendingLayout);
  }
  _pendingLayout = null;
  _pendingSessionId = null;
}

// Hide current session's terminals (preserve them in cache)
export function hideCurrentTerminals() {
  _actions.removeInlineSnapshot();
  if (state.currentSessionId && state.terminals.length > 0) {
    flushLayoutSave();
    syncSessionCache();
    for (const entry of state.terminals) teardownTerminalResize(entry);
  }
  state.terminals = [];
  state.shellCounter = 0;
}

// Restore cached terminals for a session, returns true if restored
export function restoreSessionTerminals(sessionId) {
  const cached = sessionTerminals.get(sessionId);
  if (!cached || cached.terminals.length === 0) return false;

  cached.lastAccessed = Date.now();
  state.terminals = cached.terminals;

  initDockLayout(state.terminals, cached.dockLayout);
  for (const entry of state.terminals) setupTerminalResize(entry);

  return true;
}

// Kill and fully dispose terminals for a specific session.
// keepAlive: if true, extra shell terminals stay alive in the daemon (detach only, no kill).
// Used during offload so terminals can be re-attached on resume.
export function destroySessionTerminals(sessionId, { keepAlive = false } = {}) {
  const cached = sessionTerminals.get(sessionId);
  if (!cached) return;
  for (const entry of cached.terminals) {
    window.api.ptyDetach(entry.termId).catch(() => {});
    // Don't kill pool TUI terminals — the Claude process must stay alive.
    // With keepAlive, also skip killing extra shells (they survive in daemon).
    if (!entry.isPoolTui && !keepAlive) {
      window.api.ptyKill(entry.termId).catch(() => {});
    }
    const activeDock = sessionId === state.currentSessionId ? state.dock : null;
    disposeTerminalEntry(entry, activeDock);
  }
  sessionTerminals.delete(sessionId);
}

// Kill ALL terminals across all sessions (used on new-session)
export function killAllTerminals() {
  for (const [sid] of sessionTerminals) {
    destroySessionTerminals(sid);
  }
  for (const entry of state.terminals) {
    window.api.ptyDetach(entry.termId).catch(() => {});
    if (!entry.isPoolTui) {
      window.api.ptyKill(entry.termId).catch(() => {});
    }
    disposeTerminalEntry(entry, state.dock);
  }
  state.terminals = [];
  state.shellCounter = 0;
}

// Clean up terminals for dead sessions that haven't been accessed recently
export function cleanupStaleTerminals(liveSessions) {
  const aliveIds = new Set(
    liveSessions.filter((s) => s.alive).map((s) => s.sessionId),
  );
  const now = Date.now();
  for (const [sid, cached] of sessionTerminals) {
    if (sid === state.currentSessionId) continue; // never clean up active session
    const isDead = !aliveIds.has(sid);
    const isStale = now - cached.lastAccessed > CLEANUP_AFTER_MS;
    if (isDead && isStale) {
      destroySessionTerminals(sid);
    }
  }
}

// --- Focus management ---

export function focusTerminal() {
  const idx = getActiveTermIndex();
  const entry = idx >= 0 ? state.terminals[idx] : state.terminals[0];
  if (entry) {
    if (entry.dockTabId && state.dock) state.dock.activateTab(entry.dockTabId);
    entry.term.focus();
  }
}

// --- Reconnect ---

// Reconnect a single PTY from daemon (after app restart or reload)
export async function reconnectTerminal(ptyInfo) {
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;";

  // Match the PTY's current dimensions so replay buffer renders correctly
  const term = createTerminal({
    ...(ptyInfo.cols && { cols: ptyInfo.cols }),
    ...(ptyInfo.rows && { rows: ptyInfo.rows }),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const entry = {
    termId: ptyInfo.termId,
    pid: ptyInfo.pid,
    term,
    fitAddon,
    container,
    isPoolTui: !!ptyInfo.isPoolTui,
    dockTabId: null,
    _resizeHandler: null,
  };

  if (ptyInfo.buffer) {
    term.write(ptyInfo.buffer);
    entry.skipReplay = true;
  }

  pendingTerminals.set(ptyInfo.termId, entry);

  try {
    await window.api.ptyAttach(ptyInfo.termId);
  } catch (err) {
    pendingTerminals.delete(ptyInfo.termId);
    term.dispose();
    container.remove();
    throw err;
  }

  pendingTerminals.delete(ptyInfo.termId);

  if (ptyInfo.exited) term.write("\r\n[Process exited]\r\n");

  wireTerminalInput(term, ptyInfo.termId);
  setupTerminalResize(entry);

  return entry;
}

// On app start: reconnect to any PTYs that survived from previous instance
export async function reconnectAllPtys() {
  const ptys = await window.api.ptyList();
  debugLog("startup", `reconnecting ${ptys.length} PTYs`);
  if (ptys.length === 0) return;

  // Identify pool slot termIds so we can tag reconnected terminals
  const pool = await window.api.poolRead();
  const poolTermIds = new Set();
  if (pool) {
    for (const slot of pool.slots) {
      poolTermIds.add(slot.termId);
    }
  }

  // Group by sessionId
  const bySession = new Map();
  for (const p of ptys) {
    p.isPoolTui = poolTermIds.has(p.termId);
    const sid = p.sessionId || "__none__";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(p);
  }

  // Reconnect each session's terminals (skip orphaned terminals with no session)
  for (const [sid, sessionPtys] of bySession) {
    if (sid === "__none__") {
      // Don't detach pool-slot PTYs — they may not have a sessionId yet
      // (trackNewSlot hasn't resolved). Detaching them would orphan the
      // Claude process and break pool status detection.
      const orphans = sessionPtys.filter((p) => !p.isPoolTui);
      if (orphans.length > 0) {
        debugLog("startup", `detaching ${orphans.length} orphaned PTYs`);
        for (const p of orphans) {
          window.api.ptyDetach(p.termId).catch(() => {});
        }
      }
      continue;
    }
    const results = await Promise.allSettled(
      sessionPtys.map((p) => reconnectTerminal(p)),
    );
    const entries = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        entries.push(r.value);
      } else {
        debugLog(
          "startup",
          `failed to reconnect termId=${sessionPtys[i].termId} session=${sid}: ${r.reason.message}`,
        );
      }
    }
    if (entries.length === 0) continue; // All terminals failed — skip session
    const savedLayout = await window.api.loadLayout(sid);
    sessionTerminals.set(sid, {
      terminals: entries,
      dockLayout: savedLayout || null,
      lastAccessed: Date.now(),
    });
  }

  // Restore the most recent alive session that has terminals
  const sessions = await window.api.getSessions();
  const lastActive = sessions.find(
    (s) => s.alive && sessionTerminals.has(s.sessionId),
  );
  if (lastActive) {
    state.currentSessionId = lastActive.sessionId;
    state.currentSessionCwd = lastActive.cwd;

    const cached = sessionTerminals.get(lastActive.sessionId);
    state.terminals = cached.terminals;

    dom.emptyState.classList.add("hidden");
    dom.sessionView.classList.remove("hidden");

    ensureEditorContainer();
    state.editorProject.textContent = lastActive.project
      ? `${lastActive.project} — ${_actions.displayPath(lastActive)}`
      : lastActive.sessionId;

    const content = await window.api.readIntention(lastActive.sessionId);
    _actions.createEditor(content);
    await window.api.watchIntention(lastActive.sessionId);

    // Set up dock with restored terminals (including saved layout)
    initDockLayout(state.terminals, cached.dockLayout);

    // Focus the terminal so the user can type immediately
    focusTerminal();
  }
}

// --- PTY IPC handlers (wired on module load) ---

// Wire PTY output from daemon (via main process)
window.api.onPtyData((termId, data) => {
  const entry = findTerminalEntry(termId);
  if (entry) entry.term.write(data);
  // Also forward to popup terminal if open (may be same or different entry)
  const popup = popupTerminals.get(termId);
  if (popup && popup !== entry) popup.term.write(data);
});

window.api.onPtyReplay((termId, data) => {
  const entry = findTerminalEntry(termId);
  // Skip if buffer was already written directly during reconnect
  if (entry && !entry.skipReplay) entry.term.write(data);
  // Popup always receives replay (it never has skipReplay)
  const popup = popupTerminals.get(termId);
  if (popup && popup !== entry) popup.term.write(data);
});

window.api.onPtyExit((termId) => {
  const entry = findTerminalEntry(termId);
  if (entry) entry.term.write("\r\n[Process exited]\r\n");
  const popup = popupTerminals.get(termId);
  if (popup && popup !== entry) popup.term.write("\r\n[Process exited]\r\n");
});

// API-spawned terminal: attach to it and show a tab (if it belongs to current session)
window.api.onApiTermOpened(async (sessionId, termId) => {
  if (sessionId !== state.currentSessionId) return;
  if (state.terminals.some((t) => t.termId === termId)) return;

  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;";

  const term = createTerminal();
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const entry = {
    termId,
    pid: null,
    term,
    fitAddon,
    container,
    isPoolTui: false,
    dockTabId: null,
    _resizeHandler: null,
  };
  state.terminals.push(entry);

  pendingTerminals.set(termId, entry);
  try {
    await window.api.ptyAttach(termId);
  } catch (err) {
    debugLog("api-term", `attach failed termId=${termId}`, err.message);
    const idx = state.terminals.indexOf(entry);
    if (idx !== -1) state.terminals.splice(idx, 1);
    term.dispose();
    container.remove();
    pendingTerminals.delete(termId);
    return;
  }
  pendingTerminals.delete(termId);

  wireTerminalInput(term, termId);
  setupTerminalResize(entry);

  dockRegisterTerminal(entry);
  if (state.dock) {
    const tuiTab = state.terminals.find((t) => t.isPoolTui)?.dockTabId;
    const leaf =
      (tuiTab && state.dock.getTabLeafId(tuiTab)) ||
      state.dock.getFirstLeafId();
    state.dock.addTab(entry.dockTabId, leaf);
  }
  syncSessionCache();
});

// API-closed terminal: clean up the renderer side
window.api.onApiTermClosed((sessionId, termId) => {
  if (sessionId !== state.currentSessionId) return;
  const idx = state.terminals.findIndex((t) => t.termId === termId);
  if (idx === -1) return;

  const entry = state.terminals[idx];
  window.api.ptyDetach(entry.termId).catch(() => {});
  disposeTerminalEntry(entry, state.dock);
  state.terminals.splice(idx, 1);

  if (state.terminals.length === 0) {
    dom.sessionView.classList.add("hidden");
    dom.emptyState.classList.remove("hidden");
  }

  syncSessionCache();
});
