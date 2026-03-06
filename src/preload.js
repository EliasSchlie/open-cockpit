const { contextBridge, ipcRenderer } = require("electron");

// Remove stale listeners from previous renderer loads (Cmd+R)
const channels = [
  "intention-changed",
  "sessions-changed",
  "pty-data",
  "pty-replay",
  "pty-exit",
  "new-terminal-tab",
  "close-terminal-tab",
  "next-terminal-tab",
  "prev-terminal-tab",
  "switch-terminal-tab",
  "new-session",
  "next-session",
  "prev-session",
  "toggle-sidebar",
  "focus-editor",
  "focus-terminal",
  "toggle-command-palette",
  "toggle-pane-focus",
  "cycle-pane",
  "focus-external",
  "jump-recent-idle",
  "archive-current-session",
];
for (const ch of channels) ipcRenderer.removeAllListeners(ch);

contextBridge.exposeInMainWorld("api", {
  debugLog: (tag, ...args) => ipcRenderer.send("debug-log", tag, args),
  getDirColors: () => ipcRenderer.invoke("get-dir-colors"),
  getSessions: () => ipcRenderer.invoke("get-sessions"),
  readIntention: (sessionId) => ipcRenderer.invoke("read-intention", sessionId),
  writeIntention: (sessionId, content) =>
    ipcRenderer.invoke("write-intention", sessionId, content),
  watchIntention: (sessionId) =>
    ipcRenderer.invoke("watch-intention", sessionId),
  onIntentionChanged: (callback) =>
    ipcRenderer.on("intention-changed", (_e, content) => callback(content)),
  onSessionsChanged: (callback) =>
    ipcRenderer.on("sessions-changed", () => callback()),

  // External terminal focus
  focusExternalTerminal: (pid) =>
    ipcRenderer.invoke("focus-external-terminal", pid),

  // Pool / offload
  offloadSession: (sessionId, termId, claudeSessionId, sessionInfo) =>
    ipcRenderer.invoke(
      "offload-session",
      sessionId,
      termId,
      claudeSessionId,
      sessionInfo,
    ),
  removeOffloadData: (sessionId) =>
    ipcRenderer.invoke("remove-offload-data", sessionId),
  readOffloadSnapshot: (sessionId) =>
    ipcRenderer.invoke("read-offload-snapshot", sessionId),
  readOffloadMeta: (sessionId) =>
    ipcRenderer.invoke("read-offload-meta", sessionId),
  archiveSession: (sessionId) =>
    ipcRenderer.invoke("archive-session", sessionId),
  unarchiveSession: (sessionId) =>
    ipcRenderer.invoke("unarchive-session", sessionId),

  // Pool management
  poolInit: (size) => ipcRenderer.invoke("pool-init", size),
  poolResize: (newSize) => ipcRenderer.invoke("pool-resize", newSize),
  poolHealth: () => ipcRenderer.invoke("pool-health"),
  poolRead: () => ipcRenderer.invoke("pool-read"),
  poolDestroy: () => ipcRenderer.invoke("pool-destroy"),
  poolClean: () => ipcRenderer.invoke("pool-clean"),
  poolResume: (sessionId) => ipcRenderer.invoke("pool-resume", sessionId),

  // Terminal (forwarded to PTY daemon via main process)
  ptySpawn: (opts) => ipcRenderer.invoke("pty-spawn", opts),
  ptyWrite: (termId, data) => ipcRenderer.invoke("pty-write", termId, data),
  ptyResize: (termId, cols, rows) =>
    ipcRenderer.invoke("pty-resize", termId, cols, rows),
  ptyKill: (termId) => ipcRenderer.invoke("pty-kill", termId),
  ptyList: () => ipcRenderer.invoke("pty-list"),
  ptyAttach: (termId) => ipcRenderer.invoke("pty-attach", termId),
  ptyDetach: (termId) => ipcRenderer.invoke("pty-detach", termId),
  ptySetSession: (termId, sessionId) =>
    ipcRenderer.invoke("pty-set-session", termId, sessionId),
  ptyWaitSession: (pid) => ipcRenderer.invoke("pty-wait-session", pid),
  onPtyData: (callback) =>
    ipcRenderer.on("pty-data", (_e, termId, data) => callback(termId, data)),
  onPtyReplay: (callback) =>
    ipcRenderer.on("pty-replay", (_e, termId, data) => callback(termId, data)),
  onPtyExit: (callback) =>
    ipcRenderer.on("pty-exit", (_e, termId) => callback(termId)),

  // Setup scripts
  listSetupScripts: () => ipcRenderer.invoke("list-setup-scripts"),
  readSetupScript: (name) => ipcRenderer.invoke("read-setup-script", name),

  // Shortcut settings
  getShortcuts: () => ipcRenderer.invoke("get-shortcuts"),
  getDefaultShortcut: (actionId) =>
    ipcRenderer.invoke("get-default-shortcut", actionId),
  setShortcut: (actionId, accelerator) =>
    ipcRenderer.invoke("set-shortcut", actionId, accelerator),
  resetShortcut: (actionId) => ipcRenderer.invoke("reset-shortcut", actionId),

  // Menu actions
  onNewTerminalTab: (callback) =>
    ipcRenderer.on("new-terminal-tab", () => callback()),
  onCloseTerminalTab: (callback) =>
    ipcRenderer.on("close-terminal-tab", () => callback()),
  onNextTerminalTab: (callback) =>
    ipcRenderer.on("next-terminal-tab", () => callback()),
  onPrevTerminalTab: (callback) =>
    ipcRenderer.on("prev-terminal-tab", () => callback()),
  onSwitchTerminalTab: (callback) =>
    ipcRenderer.on("switch-terminal-tab", (_e, index) => callback(index)),

  // Navigation actions
  onNewSession: (callback) => ipcRenderer.on("new-session", () => callback()),
  onNextSession: (callback) => ipcRenderer.on("next-session", () => callback()),
  onPrevSession: (callback) => ipcRenderer.on("prev-session", () => callback()),
  onToggleSidebar: (callback) =>
    ipcRenderer.on("toggle-sidebar", () => callback()),
  onFocusEditor: (callback) => ipcRenderer.on("focus-editor", () => callback()),
  onFocusTerminal: (callback) =>
    ipcRenderer.on("focus-terminal", () => callback()),
  onToggleCommandPalette: (callback) =>
    ipcRenderer.on("toggle-command-palette", () => callback()),
  onTogglePaneFocus: (callback) =>
    ipcRenderer.on("toggle-pane-focus", () => callback()),
  onCyclePane: (callback) => ipcRenderer.on("cycle-pane", () => callback()),
  onFocusExternalTerminal: (callback) =>
    ipcRenderer.on("focus-external", () => callback()),
  onJumpRecentIdle: (callback) =>
    ipcRenderer.on("jump-recent-idle", () => callback()),
  onArchiveCurrentSession: (callback) =>
    ipcRenderer.on("archive-current-session", () => callback()),
});
