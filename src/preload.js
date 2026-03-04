const { contextBridge, ipcRenderer } = require("electron");

// Remove stale listeners from previous renderer loads (Cmd+R)
const channels = [
  "intention-changed",
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
];
for (const ch of channels) ipcRenderer.removeAllListeners(ch);

contextBridge.exposeInMainWorld("api", {
  getDirColors: () => ipcRenderer.invoke("get-dir-colors"),
  getSessions: () => ipcRenderer.invoke("get-sessions"),
  readIntention: (sessionId) => ipcRenderer.invoke("read-intention", sessionId),
  writeIntention: (sessionId, content) =>
    ipcRenderer.invoke("write-intention", sessionId, content),
  watchIntention: (sessionId) =>
    ipcRenderer.invoke("watch-intention", sessionId),
  onIntentionChanged: (callback) =>
    ipcRenderer.on("intention-changed", (_e, content) => callback(content)),

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
});
