const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const {
  loadShortcuts,
  getShortcut,
  getAllShortcuts,
  getDefaultShortcut,
  setShortcut,
  resetShortcut,
  findMatchingInputAction,
  INPUT_EVENT_ACTIONS,
} = require("./shortcuts");
const { createApiServer } = require("./api-server");
const { secureMkdirSync } = require("./secure-fs");
const {
  IS_DEV,
  OWN_POOL,
  COLORS_FILE,
  SESSION_PIDS_DIR,
  IDLE_SIGNALS_DIR,
  SETUP_SCRIPTS_DIR,
  API_SOCKET,
  DEBUG_LOG_FILE,
  DEBUG_LOG_MAX_SIZE,
} = require("./paths");
const daemonClient = require("./daemon-client");
const sessionDiscovery = require("./session-discovery");
const poolManager = require("./pool-manager");
const apiHandlersModule = require("./api-handlers");
const sessionStats = require("./session-stats");
const autoUpdater = require("./auto-updater");
const { checkFirstRun } = require("./first-run");

// --- Debug logging ---
// Append timestamped lines to ~/.open-cockpit/debug.log.
// Used by both main and renderer (via IPC). Rotates at 2 MB.
let debugLogFd = null;
let debugLogSize = 0;
function debugLog(tag, ...args) {
  const line = `${new Date().toISOString()} [${tag}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  try {
    if (!debugLogFd) {
      debugLogFd = fs.openSync(DEBUG_LOG_FILE, "a", 0o600);
      debugLogSize = fs.fstatSync(debugLogFd).size;
    }
    if (debugLogSize > DEBUG_LOG_MAX_SIZE) {
      fs.closeSync(debugLogFd);
      try {
        fs.renameSync(DEBUG_LOG_FILE, DEBUG_LOG_FILE + ".1");
      } catch {
        /* rename may fail if file was already rotated */
      }
      debugLogFd = fs.openSync(DEBUG_LOG_FILE, "a", 0o600);
      debugLogSize = 0;
    }
    fs.writeSync(debugLogFd, line);
    debugLogSize += Buffer.byteLength(line);
  } catch {
    // Last resort — don't crash the app over logging
  }
}
function closeDebugLog() {
  if (debugLogFd !== null) {
    try {
      fs.closeSync(debugLogFd);
    } catch {
      /* best-effort close */
    }
    debugLogFd = null;
  }
}

// --- Window management ---
let mainWindow = null;
let dialogOpen = false;
const pendingPolls = new Set();

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
  const inputEventChannels = {
    "next-terminal-tab-alt": "next-terminal-tab",
    "prev-terminal-tab-alt": "prev-terminal-tab",
    "next-session": "next-session",
    "prev-session": "prev-session",
    "cycle-pane": "cycle-pane",
    "toggle-children": "toggle-children",
    "next-child-session": "next-child-session",
    "prev-child-session": "prev-child-session",
  };

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape" && !input.meta && !input.control && !input.alt) {
      mainWindow.webContents.send("focus-terminal");
      return;
    }

    const matchedAction = findMatchingInputAction(input);
    if (matchedAction) {
      // When a modal dialog is open, skip input-event shortcuts so the
      // renderer's own keydown handlers can process them instead.
      if (dialogOpen) return;
      event.preventDefault();
      const channel = inputEventChannels[matchedAction] || matchedAction;
      mainWindow.webContents.send(channel);
    }
  });

  // Reset dialog state if renderer reloads (prevents stuck dialogOpen)
  mainWindow.webContents.on("did-finish-load", () => {
    dialogOpen = false;
  });

  mainWindow.webContents.on("console-message", (_e, level, message) => {
    console.log(`[renderer] ${message}`);
  });
}

const send = (channel, ...args) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
};

// Build menu with keyboard shortcuts (dynamic from config)
function buildMenu() {
  function accel(actionId) {
    if (INPUT_EVENT_ACTIONS.has(actionId)) return undefined;
    const shortcut = getShortcut(actionId);
    return shortcut || undefined;
  }

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
          accelerator: accel("new-session"),
          click: () => send("new-session"),
        },
        {
          label: "New Custom Session",
          accelerator: accel("new-custom-session"),
          click: () => send("new-custom-session"),
        },
        {
          label: "New Terminal Tab",
          accelerator: accel("new-terminal-tab"),
          click: () => send("new-terminal-tab"),
        },
        {
          label: "Close Terminal Tab",
          accelerator: accel("close-terminal-tab"),
          click: () => send("close-terminal-tab"),
        },
        { type: "separator" },
        {
          label: "Next Tab",
          accelerator: accel("next-tab"),
          click: () => send("next-terminal-tab"),
        },
        {
          label: "Previous Tab",
          accelerator: accel("prev-tab"),
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
          accelerator: accel("next-session"),
          click: () => send("next-session"),
        },
        {
          label: "Previous Session",
          accelerator: accel("prev-session"),
          click: () => send("prev-session"),
        },
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          accelerator: accel("toggle-sidebar"),
          click: () => send("toggle-sidebar"),
        },
        {
          label: "Cycle Pane Focus",
          accelerator: accel("cycle-pane"),
          click: () => send("cycle-pane"),
        },
        {
          label: "Toggle Pane Focus",
          accelerator: accel("toggle-pane-focus"),
          click: () => send("toggle-pane-focus"),
        },
        {
          label: "Focus Editor",
          accelerator: accel("focus-editor"),
          click: () => send("focus-editor"),
        },
        {
          label: "Focus Terminal",
          accelerator: accel("focus-terminal"),
          click: () => send("focus-terminal"),
        },
        {
          label: "Focus External Terminal",
          accelerator: accel("focus-external"),
          click: () => send("focus-external"),
        },
        {
          label: "Open in Cursor",
          accelerator: accel("open-in-cursor"),
          click: () => send("open-in-cursor"),
        },
        { type: "separator" },
        {
          label: "Focus Next Pane",
          accelerator: accel("focus-next-pane"),
          click: () => send("focus-next-pane"),
        },
        {
          label: "Focus Previous Pane",
          accelerator: accel("focus-prev-pane"),
          click: () => send("focus-prev-pane"),
        },
        {
          label: "Split Right",
          accelerator: accel("split-right"),
          click: () => send("split-right"),
        },
        {
          label: "Split Down",
          accelerator: accel("split-down"),
          click: () => send("split-down"),
        },
        { type: "separator" },
        {
          label: "Jump to Recent Idle",
          accelerator: accel("jump-recent-idle"),
          click: () => send("jump-recent-idle"),
        },
        {
          label: "Archive Current Session",
          accelerator: accel("archive-current-session"),
          click: () => send("archive-current-session"),
        },
        { type: "separator" },
        {
          label: "Search Sessions",
          accelerator: accel("session-search"),
          click: () => send("session-search"),
        },
        {
          label: "Command Palette",
          accelerator: accel("toggle-command-palette"),
          click: () => send("toggle-command-palette"),
        },
        {
          label: "Session Info",
          accelerator: accel("session-info"),
          click: () => send("session-info"),
        },
        {
          label: "Settings",
          accelerator: accel("open-pool-settings"),
          click: () => send("open-pool-settings"),
        },
        {
          label: "Toggle Bell",
          accelerator: accel("toggle-bell"),
          click: () => send("toggle-bell"),
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
}

// --- App startup ---

let ownsApiSocket = false;

app.whenReady().then(async () => {
  debugLog("main", `starting${IS_DEV ? " (dev)" : ""} pid=${process.pid}`);

  // First-run checks: claude binary, plugin, ~/.open-cockpit/ directory
  await checkFirstRun();

  secureMkdirSync(SETUP_SCRIPTS_DIR, { recursive: true });

  // Initialize modules
  daemonClient.init({
    onPtyEvent: (msg) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (msg.type === "data")
        mainWindow.webContents.send("pty-data", msg.termId, msg.data);
      else if (msg.type === "exit")
        mainWindow.webContents.send("pty-exit", msg.termId);
      else if (msg.type === "replay")
        mainWindow.webContents.send("pty-replay", msg.termId, msg.data);
    },
    debugLog,
  });

  sessionDiscovery.init({
    debugLog,
    onSessionsChanged: () => send("sessions-changed"),
  });

  poolManager.init({
    debugLog,
    onIntentionChanged: (content) => send("intention-changed", content),
    onPoolSlotsRecovered: (recovered) =>
      send("pool-slots-recovered", recovered),
  });

  apiHandlersModule.init({ getMainWindow: () => mainWindow });

  // Start daemon connection early
  try {
    await daemonClient.ensureDaemon();
  } catch (err) {
    console.error("[main] Failed to start daemon:", err.message);
  }

  // Clean up stale idle signal files before reconciling pool
  try {
    poolManager.cleanupStaleIdleSignals();
  } catch (err) {
    console.error("[main] Idle signal cleanup failed:", err.message);
  }

  // Reconcile pool state with surviving daemon terminals (startup + periodic)
  try {
    await poolManager.reconcilePool();
  } catch (err) {
    console.error("[main] Pool reconciliation failed:", err.message);
  }
  setInterval(async () => {
    try {
      await poolManager.reconcilePool();
    } catch {
      /* logged inside reconcilePool */
    }
    try {
      await poolManager.preWarmPool();
    } catch {
      /* logged inside preWarmPool */
    }
    try {
      await poolManager.reapOrphanedTerminals();
    } catch {
      /* logged inside reapOrphanedTerminals */
    }
  }, 30000);

  // Watch session-pids and idle-signals dirs for changes -> push updates to renderer.
  // Debounced: fs.watch fires multiple events per operation.
  let watchDebounce = null;
  function onDirChange() {
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      watchDebounce = null;
      sessionDiscovery.invalidateSessionsCache();
      send("sessions-changed");
    }, 200);
  }
  for (const dir of [SESSION_PIDS_DIR, IDLE_SIGNALS_DIR]) {
    secureMkdirSync(dir, { recursive: true });
    try {
      fs.watch(dir, { persistent: false }, onDirChange);
    } catch (err) {
      console.error(`[main] fs.watch failed on ${dir}:`, err.message);
    }
  }

  // Lightweight periodic liveness check: detect dead processes between fingerprint refreshes.
  const LIVENESS_CHECK_INTERVAL = 3000;
  const knownAlivePids = new Set();
  setInterval(() => {
    if (!fs.existsSync(SESSION_PIDS_DIR)) return;
    let files;
    try {
      files = fs.readdirSync(SESSION_PIDS_DIR);
    } catch {
      /* ENOENT — dir may have been removed */
      return;
    }
    const currentFiles = new Set(files);
    for (const pid of knownAlivePids) {
      if (!currentFiles.has(pid)) knownAlivePids.delete(pid);
    }
    let anyDied = false;
    for (const pid of files) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        process.kill(Number(pid), 0);
        knownAlivePids.add(pid);
      } catch {
        /* ESRCH expected — process existence check */
        if (knownAlivePids.has(pid)) {
          knownAlivePids.delete(pid);
          anyDied = true;
        }
      }
    }
    if (anyDied) onDirChange();
  }, LIVENESS_CHECK_INTERVAL);

  // Poll fresh terminal buffers for input detection (ground truth)
  setInterval(
    () => sessionDiscovery.pollTerminalInput().catch(() => {}),
    10_000,
  );

  // Debug logging IPC (renderer -> main)
  ipcMain.on("debug-log", (_e, tag, args) => {
    debugLog(tag, ...args);
  });

  // Terminal dimensions: renderer reports actual cols/rows so pool spawns
  // can use them instead of the 80×24 daemon default.
  ipcMain.on("report-terminal-dims", (_e, cols, rows) => {
    poolManager.setTerminalDims(cols, rows);
  });

  // --- Register shared IPC handlers ---
  const { sharedHandlers, ipcArgMap } = apiHandlersModule;
  for (const [name, argMapper] of Object.entries(ipcArgMap)) {
    ipcMain.handle(name, (_e, ...args) =>
      sharedHandlers[name](argMapper(...args)),
    );
  }

  // --- IPC-only handlers (no API equivalent) ---
  ipcMain.handle("get-dir-colors", () => {
    try {
      return JSON.parse(fs.readFileSync(COLORS_FILE, "utf-8"));
    } catch {
      /* ENOENT expected — colors.json is optional */
      return {};
    }
  });
  ipcMain.handle("watch-intention", (_e, sessionId) => {
    poolManager.validateSessionId(sessionId);
    return poolManager.watchIntention(sessionId);
  });
  ipcMain.handle("pty-resize", async (_e, termId, cols, rows) => {
    await daemonClient.ensureDaemon();
    daemonClient.daemonSendSafe({ type: "resize", termId, cols, rows });
  });
  ipcMain.handle("pty-attach", async (_e, termId) => {
    const resp = await daemonClient.daemonRequest({
      type: "attach",
      termId,
    });
    return resp;
  });
  ipcMain.handle("pty-detach", async (_e, termId) => {
    await daemonClient.ensureDaemon();
    daemonClient.daemonSendSafe({ type: "detach", termId });
  });
  ipcMain.handle("pty-set-session", async (_e, termId, sessionId) => {
    await daemonClient.daemonRequest({
      type: "set-session",
      termId,
      sessionId,
    });
  });
  ipcMain.handle("focus-external-terminal", (_e, pid) =>
    poolManager.focusExternalTerminal(pid),
  );
  ipcMain.handle("close-external-terminal", (_e, pid) =>
    poolManager.closeExternalTerminal(pid),
  );
  ipcMain.handle("open-in-cursor", (_e, cwd) => poolManager.openInCursor(cwd));
  ipcMain.handle(
    "offload-session",
    async (_e, sessionId, termId, claudeSessionId, sessionInfo) =>
      poolManager.offloadSession(
        sessionId,
        termId,
        claudeSessionId,
        sessionInfo,
      ),
  );
  ipcMain.handle("remove-offload-data", (_e, sessionId) =>
    poolManager.removeOffloadData(sessionId),
  );
  ipcMain.handle("read-offload-snapshot", (_e, sessionId) =>
    poolManager.readOffloadSnapshot(sessionId),
  );
  ipcMain.handle("read-offload-meta", (_e, sessionId) =>
    poolManager.readOffloadMeta(sessionId),
  );
  ipcMain.handle("list-setup-scripts", () => {
    try {
      return fs
        .readdirSync(SETUP_SCRIPTS_DIR)
        .filter((f) => !f.startsWith("."))
        .sort();
    } catch {
      /* ENOENT — setup-scripts dir may not exist */
      return [];
    }
  });
  ipcMain.handle("read-setup-script", (_e, name) => {
    const filePath = path.join(SETUP_SCRIPTS_DIR, path.basename(name));
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      /* ENOENT expected — script may have been deleted */
      return null;
    }
  });
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
  autoUpdater.init({ debugLog, send });

  // --- Auto-updater IPC ---
  ipcMain.handle("check-for-updates", () => autoUpdater.checkForUpdates());
  ipcMain.handle("download-update", () => autoUpdater.downloadUpdate());
  ipcMain.handle("install-update", () => autoUpdater.installUpdate());
  ipcMain.handle("get-update-state", () => autoUpdater.getState());

  // --- API server ---
  const apiHandlers = apiHandlersModule.buildApiHandlers();
  createApiServer(API_SOCKET, apiHandlers, {
    onListening: () => {
      ownsApiSocket = true;
    },
  });

  // Load shortcuts config and build initial menu
  loadShortcuts();
  buildMenu();

  // Dialog open flag — suppresses input-event shortcuts so renderer handles them
  ipcMain.on("dialog-open", (_e, open) => {
    dialogOpen = open;
  });

  // App version (read once from plugin.json — version never changes at runtime)
  let cachedAppVersion;
  try {
    const pluginJson = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", ".claude-plugin", "plugin.json"),
        "utf-8",
      ),
    );
    cachedAppVersion = pluginJson.version || "unknown";
  } catch {
    cachedAppVersion = "unknown";
  }
  ipcMain.handle("get-app-version", () => cachedAppVersion);

  // Session stats (on-demand only)
  ipcMain.handle("get-session-stats", (_e, sessionId) =>
    sessionStats.getSessionStats(sessionId),
  );
  ipcMain.handle("get-all-session-stats", () =>
    sessionStats.getAllSessionStats(),
  );

  // IPC handlers for shortcut settings
  ipcMain.handle("get-shortcuts", () => getAllShortcuts());
  ipcMain.handle(
    "get-default-shortcuts",
    () => require("./shortcuts").DEFAULT_SHORTCUTS,
  );
  ipcMain.handle("get-default-shortcut", (_e, actionId) =>
    getDefaultShortcut(actionId),
  );
  ipcMain.handle("set-shortcut", (_e, actionId, accelerator) => {
    setShortcut(actionId, accelerator);
    buildMenu();
  });
  ipcMain.handle("reset-shortcut", (_e, actionId) => {
    resetShortcut(actionId);
    buildMenu();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let ownPoolDestroyed = false;
app.on("before-quit", (e) => {
  // Dev instances with --own-pool auto-destroy their pool on quit.
  // Production instances intentionally leave the daemon and pool alive —
  // terminals persist across app restarts so users don't lose sessions.
  if (OWN_POOL && !ownPoolDestroyed) {
    e.preventDefault();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 5000),
    );
    Promise.race([poolManager.poolDestroy(), timeout])
      .then(() => debugLog("main", "own-pool destroyed on quit"))
      .catch((err) =>
        debugLog("main", "own-pool destroy failed on quit:", err.message),
      )
      .finally(() => {
        ownPoolDestroyed = true;
        app.quit();
      });
    return;
  }
  autoUpdater.destroy();
  closeDebugLog();
  daemonClient.destroySocket();
  for (const entry of pendingPolls) entry.cancel();
  pendingPolls.clear();
  // Clean up API socket — only if this instance created it
  if (ownsApiSocket) {
    try {
      fs.unlinkSync(API_SOCKET);
    } catch {
      /* ENOENT expected — socket may not exist */
    }
  }
});

app.on("window-all-closed", () => {
  for (const file of poolManager.fileWatchers.values()) fs.unwatchFile(file);
  daemonClient.destroySocket();
  if (process.platform !== "darwin") app.quit();
});
