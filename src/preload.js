const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSessions: () => ipcRenderer.invoke("get-sessions"),
  readIntention: (sessionId) => ipcRenderer.invoke("read-intention", sessionId),
  writeIntention: (sessionId, content) =>
    ipcRenderer.invoke("write-intention", sessionId, content),
});
