const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn: spawnChild } = require("child_process");

const IS_DEV = process.argv.includes("--dev");
const OPEN_COCKPIT_DIR = path.join(os.homedir(), ".open-cockpit");
const INTENTIONS_DIR = path.join(OPEN_COCKPIT_DIR, "intentions");
const COLORS_FILE = path.join(OPEN_COCKPIT_DIR, "colors.json");
const SESSION_PIDS_DIR = path.join(os.homedir(), ".claude", "session-pids");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DAEMON_SOCKET = path.join(OPEN_COCKPIT_DIR, "pty-daemon.sock");
const DAEMON_SCRIPT = path.join(__dirname, "pty-daemon.js");
const DAEMON_PID_FILE = path.join(OPEN_COCKPIT_DIR, "pty-daemon.pid");

// Track file watchers and which session each window is viewing
const fileWatchers = new Map();
let mainWindow = null;

// --- PTY Daemon Client ---
let daemonSocket = null;
let daemonConnecting = null; // Promise while connection in progress
let daemonReqId = 0;
const pendingRequests = new Map(); // reqId -> { resolve, reject }

function createWindow() {
  if (IS_DEV) {
    app.setPath("userData", path.join(app.getPath("userData"), "-dev"));
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: IS_DEV ? "Open Cockpit (DEV)" : "Open Cockpit",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Shortcuts not supported as menu accelerators — handle via input events
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control && input.key === "Tab") {
      event.preventDefault();
      mainWindow.webContents.send(
        input.shift ? "prev-terminal-tab" : "next-terminal-tab",
      );
    }
    // Alt+Up / Alt+Down — switch sessions
    if (input.alt && (input.key === "ArrowUp" || input.key === "ArrowDown")) {
      event.preventDefault();
      mainWindow.webContents.send(
        input.key === "ArrowUp" ? "prev-session" : "next-session",
      );
    }
    // Escape — focus terminal (only when not in command palette)
    if (input.key === "Escape" && !input.meta && !input.control && !input.alt) {
      mainWindow.webContents.send("focus-terminal");
    }
  });

  mainWindow.webContents.on("console-message", (_e, level, message) => {
    console.log(`[renderer] ${message}`);
  });
}

function getCwdFromJsonl(sessionId) {
  try {
    const { execFileSync } = require("child_process");
    const jsonlPath = execFileSync(
      "find",
      [CLAUDE_PROJECTS_DIR, "-name", `${sessionId}.jsonl`],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
    )
      .split("\n")[0]
      .trim();
    if (!jsonlPath) return null;

    const tail = execFileSync("tail", ["-100", jsonlPath], {
      encoding: "utf-8",
    });
    let cwd = "";
    for (const line of tail.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd) cwd = obj.cwd;
      } catch {}
    }
    return cwd || null;
  } catch {
    return null;
  }
}

function getIntentionHeading(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
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

    // Refine CWD via JSONL when spawned from $HOME
    if (cwd === os.homedir()) {
      const refined = getCwdFromJsonl(sessionId);
      if (refined && fs.existsSync(refined) && refined !== os.homedir()) {
        cwd = refined;
      }
    }

    const intentionFile = path.join(INTENTIONS_DIR, `${sessionId}.md`);
    const hasIntention = fs.existsSync(intentionFile);
    const intentionHeading = hasIntention
      ? getIntentionHeading(intentionFile)
      : null;

    // Find git root for color grouping
    // Check for .git directory (not file — worktrees have a .git file pointing elsewhere)
    let gitRoot = null;
    if (cwd) {
      let dir = cwd;
      while (dir !== path.dirname(dir)) {
        const dotGit = path.join(dir, ".git");
        try {
          if (fs.statSync(dotGit).isDirectory()) {
            gitRoot = dir;
            break;
          }
        } catch {}
        dir = path.dirname(dir);
      }
    }

    sessions.push({
      pid,
      sessionId,
      alive,
      cwd,
      home: os.homedir(),
      gitRoot,
      project: cwd ? path.basename(cwd) : null,
      hasIntention,
      intentionHeading,
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

const pendingPolls = new Set();

// --- Daemon client helpers ---

function isDaemonRunning() {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    return false;
  }
}

function startDaemon() {
  return new Promise((resolve, reject) => {
    if (isDaemonRunning()) return resolve();

    const child = spawnChild(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: "ignore",
      cwd: os.homedir(), // Don't inherit app cwd — prevents kill-by-cwd from hitting daemon
      env: { ...process.env },
    });
    child.unref();

    // Wait for socket to appear
    let attempts = 0;
    const check = () => {
      if (fs.existsSync(DAEMON_SOCKET)) return resolve();
      if (++attempts > 40) return reject(new Error("Daemon failed to start"));
      setTimeout(check, 100);
    };
    setTimeout(check, 50);
  });
}

function connectToDaemon() {
  if (daemonSocket && !daemonSocket.destroyed) return Promise.resolve();
  if (daemonConnecting) return daemonConnecting;

  daemonConnecting = new Promise((resolve, reject) => {
    const sock = net.createConnection(DAEMON_SOCKET);
    let buf = "";
    let settled = false;

    sock.on("connect", () => {
      if (settled) return; // error already fired
      settled = true;
      daemonSocket = sock;
      daemonConnecting = null;
      resolve();
    });

    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          handleDaemonMessage(JSON.parse(line));
        } catch (err) {
          console.error("[main] Daemon parse error:", err.message);
        }
      }
    });

    sock.on("close", () => {
      daemonSocket = null;
      daemonConnecting = null;
      // Reject all pending requests
      for (const [, { reject: rej }] of pendingRequests) {
        rej(new Error("Daemon disconnected"));
      }
      pendingRequests.clear();
    });

    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        daemonConnecting = null;
        reject(err);
      }
      // After connection established, errors trigger close — handled there
    });
  });

  return daemonConnecting;
}

async function ensureDaemon() {
  if (daemonSocket && !daemonSocket.destroyed) return;
  await startDaemon();
  await connectToDaemon();
}

function daemonSend(msg) {
  if (daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.write(JSON.stringify(msg) + "\n");
  }
}

async function daemonRequest(msg) {
  await ensureDaemon();
  return new Promise((resolve, reject) => {
    const id = ++daemonReqId;
    msg.id = id;
    pendingRequests.set(id, { resolve, reject });
    daemonSend(msg);
    // Timeout after 10s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Daemon request timeout"));
      }
    }, 10000);
  });
}

function handleDaemonMessage(msg) {
  // Handle response to a request
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve } = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    resolve(msg);
    return;
  }

  // Handle push events (data, exit, replay)
  if (msg.type === "data" && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pty-data", msg.termId, msg.data);
    return;
  }
  if (msg.type === "exit" && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pty-exit", msg.termId);
    return;
  }
  if (msg.type === "replay" && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pty-replay", msg.termId, msg.data);
    return;
  }
}

app.whenReady().then(async () => {
  // Start daemon connection early
  try {
    await ensureDaemon();
  } catch (err) {
    console.error("[main] Failed to start daemon:", err.message);
  }

  ipcMain.handle("get-dir-colors", () => {
    try {
      return JSON.parse(fs.readFileSync(COLORS_FILE, "utf-8"));
    } catch {
      return {};
    }
  });
  ipcMain.handle("get-sessions", () => getSessions());
  ipcMain.handle("read-intention", (_e, sessionId) => readIntention(sessionId));
  ipcMain.handle("write-intention", (_e, sessionId, content) =>
    writeIntention(sessionId, content),
  );
  ipcMain.handle("watch-intention", (_e, sessionId) =>
    watchIntention(sessionId),
  );

  // PTY IPC handlers — all forwarded to daemon

  ipcMain.handle("pty-spawn", async (_e, { cwd, cmd, args, sessionId }) => {
    const resp = await daemonRequest({
      type: "spawn",
      cwd,
      cmd,
      args,
      sessionId,
    });
    return { termId: resp.termId, pid: resp.pid };
  });

  ipcMain.handle("pty-write", async (_e, termId, data) => {
    await ensureDaemon();
    daemonSend({ type: "write", termId, data });
  });

  ipcMain.handle("pty-resize", async (_e, termId, cols, rows) => {
    await ensureDaemon();
    daemonSend({ type: "resize", termId, cols, rows });
  });

  ipcMain.handle("pty-kill", async (_e, termId) => {
    await daemonRequest({ type: "kill", termId });
  });

  ipcMain.handle("pty-list", async () => {
    const resp = await daemonRequest({ type: "list" });
    return resp.ptys;
  });

  ipcMain.handle("pty-attach", async (_e, termId) => {
    const resp = await daemonRequest({ type: "attach", termId });
    return resp;
  });

  ipcMain.handle("pty-detach", async (_e, termId) => {
    await ensureDaemon();
    daemonSend({ type: "detach", termId });
  });

  ipcMain.handle("pty-set-session", async (_e, termId, sessionId) => {
    await daemonRequest({ type: "set-session", termId, sessionId });
  });

  // Poll for a session-pid file to appear for a given PID
  ipcMain.handle("pty-wait-session", (_e, pid) => {
    return new Promise((resolve) => {
      let attempts = 0;
      let timer = null;
      const entry = {
        cancel: () => {
          clearTimeout(timer);
          resolve(null);
        },
      };
      pendingPolls.add(entry);
      const check = () => {
        const file = path.join(SESSION_PIDS_DIR, String(pid));
        if (fs.existsSync(file)) {
          const sessionId = fs.readFileSync(file, "utf-8").trim();
          if (sessionId) {
            pendingPolls.delete(entry);
            return resolve(sessionId);
          }
        }
        if (++attempts < 60) {
          timer = setTimeout(check, 500);
        } else {
          pendingPolls.delete(entry);
          resolve(null);
        }
      };
      check();
    });
  });

  createWindow();

  const send = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // Build menu with keyboard shortcuts
  const menuTemplate = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Claude Session",
          accelerator: "CmdOrCtrl+N",
          click: () => send("new-session"),
        },
        {
          label: "New Terminal Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => send("new-terminal-tab"),
        },
        {
          label: "Close Terminal Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => send("close-terminal-tab"),
        },
        { type: "separator" },
        {
          label: "Next Tab",
          accelerator: "CmdOrCtrl+Shift+]",
          click: () => send("next-terminal-tab"),
        },
        {
          label: "Previous Tab",
          accelerator: "CmdOrCtrl+Shift+[",
          click: () => send("prev-terminal-tab"),
        },
        { type: "separator" },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => send("switch-terminal-tab", i),
        })),
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Navigate",
      submenu: [
        {
          label: "Next Session",
          accelerator: "Alt+Down",
          click: () => send("next-session"),
        },
        {
          label: "Previous Session",
          accelerator: "Alt+Up",
          click: () => send("prev-session"),
        },
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+\\",
          click: () => send("toggle-sidebar"),
        },
        {
          label: "Focus Editor",
          accelerator: "CmdOrCtrl+E",
          click: () => send("focus-editor"),
        },
        {
          label: "Focus Terminal",
          accelerator: "CmdOrCtrl+`",
          click: () => send("focus-terminal"),
        },
        { type: "separator" },
        {
          label: "Command Palette",
          accelerator: "CmdOrCtrl+/",
          click: () => send("toggle-command-palette"),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  // Disconnect from daemon (daemon keeps PTYs alive)
  if (daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.destroy();
  }
  for (const entry of pendingPolls) entry.cancel();
  pendingPolls.clear();
});

app.on("window-all-closed", () => {
  for (const file of fileWatchers.values()) fs.unwatchFile(file);
  if (daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.destroy();
  }
  if (process.platform !== "darwin") app.quit();
});
