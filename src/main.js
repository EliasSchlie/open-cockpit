const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const INTENTIONS_DIR = path.join(os.homedir(), ".intentions");
const SESSION_PIDS_DIR = path.join(os.homedir(), ".claude", "session-pids");

// Track file watchers and which session each window is viewing
const fileWatchers = new Map();
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.on("console-message", (_e, level, message) => {
    console.log(`[renderer] ${message}`);
  });
}

function getSessions() {
  if (!fs.existsSync(SESSION_PIDS_DIR)) return [];

  const sessions = [];
  for (const file of fs.readdirSync(SESSION_PIDS_DIR)) {
    const pid = file;
    const sessionId = fs
      .readFileSync(path.join(SESSION_PIDS_DIR, file), "utf-8")
      .trim();
    if (!sessionId) continue;

    let alive = false;
    try {
      process.kill(Number(pid), 0);
      alive = true;
    } catch {
      alive = false;
    }

    let cwd = null;
    if (alive) {
      try {
        const lsof = require("child_process").execSync(
          `lsof -a -p ${pid} -d cwd -F n 2>/dev/null`,
          { encoding: "utf-8" },
        );
        const match = lsof.match(/^n(.+)$/m);
        if (match) cwd = match[1];
      } catch {}
    }

    const intentionFile = path.join(INTENTIONS_DIR, `${sessionId}.md`);
    const hasIntention = fs.existsSync(intentionFile);

    sessions.push({
      pid,
      sessionId,
      alive,
      cwd,
      project: cwd ? path.basename(cwd) : null,
      hasIntention,
    });
  }

  sessions.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return Number(b.pid) - Number(a.pid);
  });

  return sessions;
}

function readIntention(sessionId) {
  const file = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}

// Track the last content we wrote so we can detect external changes
let lastWrittenContent = null;

function writeIntention(sessionId, content) {
  fs.mkdirSync(INTENTIONS_DIR, { recursive: true });
  lastWrittenContent = content;
  fs.writeFileSync(path.join(INTENTIONS_DIR, `${sessionId}.md`), content);
}

function watchIntention(sessionId) {
  // Clean up previous watcher
  if (fileWatchers.has("current")) {
    fs.unwatchFile(fileWatchers.get("current"));
    fileWatchers.delete("current");
  }

  const file = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(INTENTIONS_DIR, { recursive: true });
    fs.writeFileSync(file, "");
  }

  // Use polling (fs.watchFile) — reliable on macOS unlike fs.watch
  fs.watchFile(file, { interval: 500 }, () => {
    try {
      const content = fs.readFileSync(file, "utf-8");
      // Skip if this is content we wrote ourselves
      if (content === lastWrittenContent) return;
      lastWrittenContent = content;
      console.log("[main] External file change detected, sending to renderer");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("intention-changed", content);
      }
    } catch {}
  });

  fileWatchers.set("current", file);
}

app.whenReady().then(() => {
  ipcMain.handle("get-sessions", () => getSessions());
  ipcMain.handle("read-intention", (_e, sessionId) => readIntention(sessionId));
  ipcMain.handle("write-intention", (_e, sessionId, content) =>
    writeIntention(sessionId, content),
  );
  ipcMain.handle("watch-intention", (_e, sessionId) =>
    watchIntention(sessionId),
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Clean up watchers
  for (const file of fileWatchers.values()) fs.unwatchFile(file);
  if (process.platform !== "darwin") app.quit();
});
