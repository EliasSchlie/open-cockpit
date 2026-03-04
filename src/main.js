const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const INTENTIONS_DIR = path.join(os.homedir(), ".intentions");
const SESSION_PIDS_DIR = path.join(os.homedir(), ".claude", "session-pids");

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

// Get active sessions: read PID map, check which are alive, resolve project dirs
function getSessions() {
  if (!fs.existsSync(SESSION_PIDS_DIR)) return [];

  const sessions = [];
  for (const file of fs.readdirSync(SESSION_PIDS_DIR)) {
    const pid = file;
    const sessionId = fs
      .readFileSync(path.join(SESSION_PIDS_DIR, file), "utf-8")
      .trim();
    if (!sessionId) continue;

    // Check if process is alive
    let alive = false;
    try {
      process.kill(Number(pid), 0);
      alive = true;
    } catch {
      alive = false;
    }

    // Get CWD of the Claude process
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

  // Sort: alive first, then by PID descending (newest first)
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

function writeIntention(sessionId, content) {
  fs.mkdirSync(INTENTIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(INTENTIONS_DIR, `${sessionId}.md`), content);
}

app.whenReady().then(() => {
  ipcMain.handle("get-sessions", () => getSessions());
  ipcMain.handle("read-intention", (_e, sessionId) => readIntention(sessionId));
  ipcMain.handle("write-intention", (_e, sessionId, content) =>
    writeIntention(sessionId, content),
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
