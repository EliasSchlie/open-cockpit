const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSessions: () => ipcRenderer.invoke("get-sessions"),
  readIntention: (sessionId) => ipcRenderer.invoke("read-intention", sessionId),
  writeIntention: (sessionId, content) =>
    ipcRenderer.invoke("write-intention", sessionId, content),
  watchIntention: (sessionId) =>
    ipcRenderer.invoke("watch-intention", sessionId),
  onIntentionChanged: (callback) =>
    ipcRenderer.on("intention-changed", (_e, content) => callback(content)),

  // Terminal
  ptySpawn: (opts) => ipcRenderer.invoke("pty-spawn", opts),
  ptyWrite: (termId, data) => ipcRenderer.invoke("pty-write", termId, data),
  ptyResize: (termId, cols, rows) =>
    ipcRenderer.invoke("pty-resize", termId, cols, rows),
  ptyKill: (termId) => ipcRenderer.invoke("pty-kill", termId),
  ptyWaitSession: (pid) => ipcRenderer.invoke("pty-wait-session", pid),
  onPtyData: (callback) =>
    ipcRenderer.on("pty-data", (_e, termId, data) => callback(termId, data)),
  onPtyExit: (callback) =>
    ipcRenderer.on("pty-exit", (_e, termId) => callback(termId)),

  // Menu actions
  onNewTerminalTab: (callback) =>
    ipcRenderer.on("new-terminal-tab", () => callback()),
  onCloseTerminalTab: (callback) =>
    ipcRenderer.on("close-terminal-tab", () => callback()),
});
