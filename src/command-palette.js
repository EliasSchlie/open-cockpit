// Command palette: COMMANDS registry, shortcut display, pane navigation, palette UI
import { state, dom, toggleBellMuted } from "./renderer-state.js";
import {
  getFocusedTabId,
  focusLeafContent,
  TAB_EDITOR,
  TAB_SNAPSHOT,
} from "./dock-helpers.js";
import { createPickerOverlay } from "./picker-overlay.js";

// --- Cross-module dependencies (set via initCommandPalette) ---
let _actions = {};
let shortcutConfig = {};
let COMMANDS = [];
let filteredCommands = [];
let picker;

export function initCommandPalette(actions) {
  _actions = actions;

  // Build COMMANDS array with action references
  COMMANDS = [
    {
      id: "next-session",
      label: "Next Session",
      shortcutAction: "next-session",
      action: () => _actions.switchSession(1),
    },
    {
      id: "prev-session",
      label: "Previous Session",
      shortcutAction: "prev-session",
      action: () => _actions.switchSession(-1),
    },
    {
      id: "toggle-children",
      label: "Toggle Child Sessions",
      shortcutAction: "toggle-children",
      action: () => _actions.toggleChildren(),
    },
    {
      id: "next-child-session",
      label: "Next Child Session",
      shortcutAction: "next-child-session",
      action: () => _actions.switchChildSession(1),
    },
    {
      id: "prev-child-session",
      label: "Previous Child Session",
      shortcutAction: "prev-child-session",
      action: () => _actions.switchChildSession(-1),
    },
    {
      id: "new-session",
      label: "New Claude Session",
      shortcutAction: "new-session",
      action: () => dom.newSessionBtn.click(),
    },
    {
      id: "new-custom-session",
      label: "New Custom Session",
      shortcutAction: "new-custom-session",
      action: () => _actions.spawnCustomSession(),
    },
    {
      id: "new-terminal",
      label: "New Terminal Tab",
      shortcutAction: "new-terminal-tab",
      action: () => {
        if (state.currentSessionId)
          _actions.spawnTerminal(state.currentSessionCwd);
      },
    },
    {
      id: "close-terminal",
      label: "Close Terminal Tab",
      shortcutAction: "close-terminal-tab",
      action: () => {
        const i = _actions.getActiveTermIndex();
        if (i >= 0) _actions.closeTerminal(i);
      },
    },
    {
      id: "next-tab",
      label: "Next Terminal Tab",
      shortcutAction: "next-tab",
      action: () => _actions.cycleTabInFocusedLeaf(1),
    },
    {
      id: "prev-tab",
      label: "Previous Terminal Tab",
      shortcutAction: "prev-tab",
      action: () => _actions.cycleTabInFocusedLeaf(-1),
    },
    {
      id: "jump-recent-idle",
      label: "Jump to Recent Idle",
      shortcutAction: "jump-recent-idle",
      action: () => _actions.jumpToRecentIdle(),
    },
    {
      id: "archive-current-session",
      label: "Archive Current Session",
      shortcutAction: "archive-current-session",
      action: () => _actions.archiveCurrentSession(),
    },
    {
      id: "resume-session",
      label: "Resume Session",
      shortcutAction: "resume-session",
      action: () => _actions.resumeCurrentSession(),
    },
    {
      id: "toggle-sidebar",
      label: "Toggle Sidebar",
      shortcutAction: "toggle-sidebar",
      action: () => _actions.toggleSidebar(),
    },
    {
      id: "cycle-pane",
      label: "Cycle Pane Focus",
      shortcutAction: "cycle-pane",
      action: cyclePane,
    },
    {
      id: "focus-next-pane",
      label: "Focus Next Pane",
      shortcutAction: "focus-next-pane",
      action: () => focusAdjacentPane(1),
    },
    {
      id: "focus-prev-pane",
      label: "Focus Previous Pane",
      shortcutAction: "focus-prev-pane",
      action: () => focusAdjacentPane(-1),
    },
    {
      id: "split-right",
      label: "Split Right",
      shortcutAction: "split-right",
      action: () => splitFocusedTab("right"),
    },
    {
      id: "split-down",
      label: "Split Down",
      shortcutAction: "split-down",
      action: () => splitFocusedTab("down"),
    },
    {
      id: "toggle-pane-focus",
      label: "Toggle Pane Focus",
      shortcutAction: "toggle-pane-focus",
      action: () => _actions.togglePaneFocus(),
    },
    {
      id: "focus-editor",
      label: "Focus Editor",
      shortcutAction: "focus-editor",
      action: () => _actions.focusEditor(),
    },
    {
      id: "focus-terminal",
      label: "Focus Terminal",
      shortcutAction: "focus-terminal",
      action: () => _actions.focusTerminal(),
    },
    {
      id: "focus-external-terminal",
      label: "Focus External Terminal",
      shortcutAction: "focus-external",
      action: () => _actions.focusCurrentExternalTerminal(),
    },
    {
      id: "open-in-cursor",
      label: "Open in Cursor",
      shortcutAction: "open-in-cursor",
      action: () => {
        if (state.currentSessionCwd)
          window.api.openInCursor(state.currentSessionCwd);
      },
    },
    {
      id: "refresh",
      label: "Refresh Sessions",
      action: () => {
        _actions.loadDirColors();
        _actions.loadSessions();
      },
    },
    {
      id: "command-palette",
      label: "Command Palette",
      shortcutAction: "toggle-command-palette",
      action: () => toggleCommandPalette(),
    },
    {
      id: "settings",
      label: "Settings",
      shortcutAction: "open-pool-settings",
      action: () => _actions.showSettings(),
    },
    {
      id: "pool-settings",
      label: "Settings: Pool",
      action: () => _actions.showSettings("pool"),
    },
    {
      id: "shortcut-settings",
      label: "Settings: Keyboard Shortcuts",
      action: () => _actions.showSettings("shortcuts"),
    },
    {
      id: "toggle-bell",
      label: "Toggle Bell",
      shortcutAction: "toggle-bell",
      action: () => toggleBellMuted(),
    },
    {
      id: "session-search",
      label: "Search Sessions",
      shortcutAction: "session-search",
      action: () => _actions.openSessionSearch(),
    },
    {
      id: "session-info",
      label: "Session Info",
      shortcutAction: "session-info",
      action: () => _actions.openSessionInfo(),
    },
  ];

  // Also add Tab 1-9 commands
  for (let i = 0; i < 9; i++) {
    COMMANDS.push({
      id: `tab-${i + 1}`,
      label: `Switch to Tab ${i + 1}`,
      shortcut: `\u2318${i + 1}`,
      action: () => {
        if (i < state.terminals.length) _actions.switchToTerminal(i);
      },
    });
  }

  // Create picker overlay
  picker = createPickerOverlay({
    overlayEl: dom.commandPalette,
    inputEl: dom.commandPaletteInput,
    listEl: dom.commandPaletteList,
    onInput: (query) => renderPaletteList(query),
    onSelect: (index) => {
      filteredCommands[index].action();
    },
    onOpen: () => renderPaletteList(""),
    onClose: () => _actions.focusTerminal(),
    getItemCount: () => filteredCommands.length,
  });
}

// --- Shortcut display helpers ---
// Convert Electron accelerator to display string (e.g. "CmdOrCtrl+N" → "⌘N")
export function formatShortcutDisplay(accel) {
  if (!accel) return "";
  return accel
    .replace(/CmdOrCtrl\+/gi, "\u2318")
    .replace(/Cmd\+/gi, "\u2318")
    .replace(/Ctrl\+/gi, "\u2303")
    .replace(/Shift\+/gi, "\u21E7")
    .replace(/Alt\+/gi, "\u2325")
    .replace(/\+/g, "")
    .replace(/Tab/gi, "\u21E5")
    .replace(/Up/gi, "\u2191")
    .replace(/Down/gi, "\u2193")
    .replace(/Left/gi, "\u2190")
    .replace(/Right/gi, "\u2192");
}

export function setShortcutConfig(config) {
  shortcutConfig = config;
}

// --- Pane navigation ---

// Cycle pane focus: editor → terminal tabs (round-robin) → back to editor
function cyclePane() {
  const activeIdx = _actions.getActiveTermIndex();
  if (state.editorMount && state.editorMount.contains(document.activeElement)) {
    _actions.focusTerminal();
  } else if (activeIdx >= 0 && state.terminals.length > 1) {
    const nextIdx = activeIdx + 1;
    if (nextIdx < state.terminals.length) {
      _actions.switchToTerminal(nextIdx);
    } else {
      _actions.focusEditor();
    }
  } else {
    _actions.focusEditor();
  }
}

// Navigate between dock leaves (panels)
function focusAdjacentPane(delta) {
  if (!state.dock) return;
  const leafIds = state.dock.getLeafIds();
  if (leafIds.length < 2) return;

  // Find which leaf currently has focus
  const focusedTabId = getFocusedTabId(state.dock, dom.dockContainer);
  let currentLeafId = focusedTabId
    ? state.dock.getTabLeafId(focusedTabId)
    : null;
  if (!currentLeafId) currentLeafId = leafIds[0];

  const idx = leafIds.indexOf(currentLeafId);
  const nextIdx = (idx + delta + leafIds.length) % leafIds.length;
  const nextLeafId = leafIds[nextIdx];

  const activeTabId = state.dock.getActiveTabInLeaf(nextLeafId);
  if (activeTabId === TAB_EDITOR || activeTabId === TAB_SNAPSHOT) {
    state.dock.activateTab(activeTabId);
    if (activeTabId === TAB_EDITOR && state.editorView)
      state.editorView.focus();
  } else {
    focusLeafContent(state.dock, nextLeafId);
  }
}

// Move the focused tab to a new split in the given direction
function splitFocusedTab(direction) {
  if (!state.dock) return;
  const focusedTabId = getFocusedTabId(state.dock, dom.dockContainer);
  if (!focusedTabId) return;
  state.dock.moveTabToSplit(focusedTabId, direction);
}

// --- Palette UI ---

export function toggleCommandPalette() {
  picker.toggle();
}

// Get display shortcut for a command (dynamic from config)
function getCommandShortcut(cmd) {
  if (!cmd.shortcutAction) return "";
  return formatShortcutDisplay(shortcutConfig[cmd.shortcutAction] || "");
}

function renderPaletteList(query) {
  const q = query.toLowerCase();
  filteredCommands = q
    ? COMMANDS.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          getCommandShortcut(c).toLowerCase().includes(q),
      )
    : COMMANDS.filter((c) => !c.id.startsWith("tab-")); // Hide tab-N from unfiltered list

  const clamped = picker.clampSelection();

  dom.commandPaletteList.innerHTML = "";
  filteredCommands.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = `overlay-picker-item command-palette-item${i === clamped ? " selected" : ""}`;
    const shortcut = getCommandShortcut(cmd);
    item.innerHTML = `<span class="command-palette-label">${cmd.label}</span><span class="command-palette-shortcut">${shortcut}</span>`;
    item.addEventListener("mouseenter", () => picker.updateSelection(i));
    dom.commandPaletteList.appendChild(item);
  });
}

export { COMMANDS, cyclePane, focusAdjacentPane, splitFocusedTab };
