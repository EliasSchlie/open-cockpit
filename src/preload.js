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
  "api-term-opened",
  "api-term-closed",
  "next-terminal-tab",
  "prev-terminal-tab",
  "switch-terminal-tab",
  "new-session",
  "new-custom-session",
  "next-session",
  "prev-session",
  "toggle-children",
  "next-child-session",
  "prev-child-session",
  "toggle-sidebar",
  "focus-editor",
  "focus-terminal",
  "toggle-command-palette",
  "toggle-pane-focus",
  "cycle-pane",
  "focus-external",
  "focus-next-pane",
  "focus-prev-pane",
  "split-right",
  "split-down",
  "jump-recent-idle",
  "archive-current-session",
  "open-in-cursor",
  "open-pool-settings",
  "session-info",
  "toggle-bell",
  "session-search",
  "pool-slots-recovered",
  "update-status-changed",
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

  // External terminal focus / close
  focusExternalTerminal: (pid) =>
    ipcRenderer.invoke("focus-external-terminal", pid),
  closeExternalTerminal: (pid) =>
    ipcRenderer.invoke("close-external-terminal", pid),

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
  poolGetFlags: () => ipcRenderer.invoke("pool-get-flags"),
  poolSetFlags: (flags) => ipcRenderer.invoke("pool-set-flags", flags),
  poolGetMinFresh: () => ipcRenderer.invoke("pool-get-min-fresh"),
  poolSetMinFresh: (n) => ipcRenderer.invoke("pool-set-min-fresh", n),
  poolResume: (sessionId) => ipcRenderer.invoke("pool-resume", sessionId),

  // Custom sessions
  spawnCustomSession: (cwd, flags) =>
    ipcRenderer.invoke("spawn-custom-session", cwd, flags),

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
  reportTerminalDims: (cols, rows) =>
    ipcRenderer.send("report-terminal-dims", cols, rows),

  // Setup scripts
  listSetupScripts: () => ipcRenderer.invoke("list-setup-scripts"),
  readSetupScript: (name) => ipcRenderer.invoke("read-setup-script", name),

  // App info
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getPluginVersion: () => ipcRenderer.invoke("get-plugin-version"),
  getDismissedPluginVersion: () =>
    ipcRenderer.invoke("get-dismissed-plugin-version"),
  dismissPluginVersion: (version) =>
    ipcRenderer.invoke("dismiss-plugin-version", version),

  // Auto-updater
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  onUpdateStatusChanged: (callback) => {
    const wrapped = (_e, state) => callback(state);
    ipcRenderer.on("update-status-changed", wrapped);
    // Store wrapped ref on the callback for removal
    callback._wrappedUpdateHandler = wrapped;
  },
  offUpdateStatusChanged: (callback) => {
    if (callback._wrappedUpdateHandler) {
      ipcRenderer.removeListener(
        "update-status-changed",
        callback._wrappedUpdateHandler,
      );
      delete callback._wrappedUpdateHandler;
    }
  },

  // Session stats (on-demand)
  getSessionStats: (sessionId) =>
    ipcRenderer.invoke("get-session-stats", sessionId),
  getAllSessionStats: () => ipcRenderer.invoke("get-all-session-stats"),
  onOpenSessionInfo: (callback) =>
    ipcRenderer.on("session-info", () => callback()),

  // Dialog state — suppresses global shortcuts while a modal is open
  setDialogOpen: (open) => ipcRenderer.send("dialog-open", open),

  // Shortcut settings
  getShortcuts: () => ipcRenderer.invoke("get-shortcuts"),
  getDefaultShortcuts: () => ipcRenderer.invoke("get-default-shortcuts"),
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
  onApiTermOpened: (callback) =>
    ipcRenderer.on("api-term-opened", (_e, sessionId, termId) =>
      callback(sessionId, termId),
    ),
  onApiTermClosed: (callback) =>
    ipcRenderer.on("api-term-closed", (_e, sessionId, termId) =>
      callback(sessionId, termId),
    ),

  // Navigation actions
  onNewSession: (callback) => ipcRenderer.on("new-session", () => callback()),
  onNewCustomSession: (callback) =>
    ipcRenderer.on("new-custom-session", () => callback()),
  onNextSession: (callback) => ipcRenderer.on("next-session", () => callback()),
  onPrevSession: (callback) => ipcRenderer.on("prev-session", () => callback()),
  onToggleChildren: (callback) =>
    ipcRenderer.on("toggle-children", () => callback()),
  onNextChildSession: (callback) =>
    ipcRenderer.on("next-child-session", () => callback()),
  onPrevChildSession: (callback) =>
    ipcRenderer.on("prev-child-session", () => callback()),
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
  onFocusNextPane: (callback) =>
    ipcRenderer.on("focus-next-pane", () => callback()),
  onFocusPrevPane: (callback) =>
    ipcRenderer.on("focus-prev-pane", () => callback()),
  onSplitRight: (callback) => ipcRenderer.on("split-right", () => callback()),
  onSplitDown: (callback) => ipcRenderer.on("split-down", () => callback()),
  onJumpRecentIdle: (callback) =>
    ipcRenderer.on("jump-recent-idle", () => callback()),
  onArchiveCurrentSession: (callback) =>
    ipcRenderer.on("archive-current-session", () => callback()),
  onOpenInCursor: (callback) =>
    ipcRenderer.on("open-in-cursor", () => callback()),
  onOpenPoolSettings: (callback) =>
    ipcRenderer.on("open-pool-settings", () => callback()),
  onToggleBell: (callback) => ipcRenderer.on("toggle-bell", () => callback()),
  onSessionSearch: (callback) =>
    ipcRenderer.on("session-search", () => callback()),

  // Open in Cursor
  openInCursor: (cwd) => ipcRenderer.invoke("open-in-cursor", cwd),

  onPoolSlotsRecovered: (callback) =>
    ipcRenderer.on("pool-slots-recovered", (_e, slots) => callback(slots)),
});
