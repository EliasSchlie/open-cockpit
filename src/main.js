const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");

const IS_DEV = process.argv.includes("--dev");
const OPEN_COCKPIT_DIR = path.join(os.homedir(), ".open-cockpit");
const INTENTIONS_DIR = path.join(OPEN_COCKPIT_DIR, "intentions");
const COLORS_FILE = path.join(OPEN_COCKPIT_DIR, "colors.json");
const SESSION_PIDS_DIR = path.join(os.homedir(), ".claude", "session-pids");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Track file watchers and which session each window is viewing
const fileWatchers = new Map();
let mainWindow = null;

// PTY management
const ptyProcesses = new Map(); // termId -> pty process
let nextTermId = 1;

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

  mainWindow.webContents.on("console-message", (_e, level, message) => {
    console.log(`[renderer] ${message}`);
  });
}

function getCwdFromJsonl(sessionId) {
  try {
    const { execSync } = require("child_process");
    const jsonlPath = execSync(
      `find ${JSON.stringify(CLAUDE_PROJECTS_DIR)} -name "${sessionId}.jsonl" 2>/dev/null | head -1`,
      { encoding: "utf-8" },
    ).trim();
    if (!jsonlPath) return null;

    const tail = execSync(`tail -100 ${JSON.stringify(jsonlPath)}`, {
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

function killAllPty() {
  for (const p of ptyProcesses.values()) {
    try {
      p.kill();
    } catch {}
  }
  ptyProcesses.clear();
  for (const entry of pendingPolls) entry.cancel();
  pendingPolls.clear();
}

app.whenReady().then(() => {
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

  // PTY IPC handlers
  const ALLOWED_SHELLS = new Set(["/bin/zsh", "/bin/bash", "/bin/sh"]);

  ipcMain.handle("pty-spawn", (_e, { cwd, cmd, args }) => {
    const shell =
      cmd && ALLOWED_SHELLS.has(cmd) ? cmd : process.env.SHELL || "/bin/zsh";
    const shellArgs = args || [];
    const termId = nextTermId++;

    // Strip Claude session env vars so spawned Claude doesn't think it's nested
    const cleanEnv = { ...process.env, TERM: "xterm-256color" };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_SESSION_ID;

    const p = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: cwd || os.homedir(),
      env: cleanEnv,
    });

    ptyProcesses.set(termId, p);

    p.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("pty-data", termId, data);
      }
    });

    p.onExit(() => {
      ptyProcesses.delete(termId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("pty-exit", termId);
      }
    });

    return { termId, pid: p.pid };
  });

  ipcMain.handle("pty-write", (_e, termId, data) => {
    const p = ptyProcesses.get(termId);
    if (p) p.write(data);
  });

  ipcMain.handle("pty-resize", (_e, termId, cols, rows) => {
    const p = ptyProcesses.get(termId);
    if (p) p.resize(cols, rows);
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

  ipcMain.handle("pty-kill", (_e, termId) => {
    const p = ptyProcesses.get(termId);
    if (p) {
      p.kill();
      ptyProcesses.delete(termId);
    }
  });

  createWindow();

  // Build menu with Cmd+T shortcut for new terminal tab
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
          label: "New Terminal Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("new-terminal-tab");
            }
          },
        },
        {
          label: "Close Terminal Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("close-terminal-tab");
            }
          },
        },
        { type: "separator" },
        { role: "close" },
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

app.on("before-quit", killAllPty);

app.on("window-all-closed", () => {
  for (const file of fileWatchers.values()) fs.unwatchFile(file);
  killAllPty();
  if (process.platform !== "darwin") app.quit();
});
