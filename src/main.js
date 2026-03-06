const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const {
  spawn: spawnChild,
  execFile,
  execFileSync,
  execSync,
} = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { sortSessions } = require("./sort-sessions");
const { createApiServer } = require("./api-server");
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
const {
  readPool: readPoolFile,
  writePool: writePoolFile,
  computePoolHealth,
  syncStatuses,
  createSlot,
  isSlotPinned,
  selectShrinkCandidates,
  findSlotBySessionId: findSlotBySessionIdInPool,
  findSlotByIndex: findSlotByIndexInPool,
  resolveSlot: resolveSlotInPool,
} = require("./pool");
const { STATUS, POOL_STATUS } = require("./session-statuses");
const { Terminal: HeadlessTerminal } = require("@xterm/headless");

// Secure file helpers — restrict to owner-only access
function secureMkdirSync(dirPath, opts = {}) {
  fs.mkdirSync(dirPath, { ...opts, mode: 0o700 });
}
function secureWriteFileSync(filePath, data, opts) {
  fs.writeFileSync(filePath, data, opts);
  fs.chmodSync(filePath, 0o600);
}

const IS_DEV = process.argv.includes("--dev");
const OPEN_COCKPIT_DIR = path.join(os.homedir(), ".open-cockpit");
const INTENTIONS_DIR = path.join(OPEN_COCKPIT_DIR, "intentions");
const COLORS_FILE = path.join(OPEN_COCKPIT_DIR, "colors.json");
const SESSION_PIDS_DIR = path.join(OPEN_COCKPIT_DIR, "session-pids");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DAEMON_SOCKET = path.join(OPEN_COCKPIT_DIR, "pty-daemon.sock");
const DAEMON_SCRIPT = path.join(__dirname, "pty-daemon.js");
const DAEMON_PID_FILE = path.join(OPEN_COCKPIT_DIR, "pty-daemon.pid");
const IDLE_SIGNALS_DIR = path.join(OPEN_COCKPIT_DIR, "idle-signals");
const OFFLOADED_DIR = path.join(OPEN_COCKPIT_DIR, "offloaded");
const OWN_POOL = process.argv.includes("--own-pool");
const POOL_FILE = path.join(
  OPEN_COCKPIT_DIR,
  OWN_POOL ? "pool-dev.json" : "pool.json",
);
const SETUP_SCRIPTS_DIR = path.join(OPEN_COCKPIT_DIR, "setup-scripts");
const SESSION_GRAPH_FILE = path.join(OPEN_COCKPIT_DIR, "session-graph.json");
const API_SOCKET = path.join(
  OPEN_COCKPIT_DIR,
  IS_DEV ? "api-dev.sock" : "api.sock",
);
const DEBUG_LOG_FILE = path.join(OPEN_COCKPIT_DIR, "debug.log");
const DEBUG_LOG_MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const DEFAULT_POOL_SIZE = 5;
const ORPHAN_TERMINAL_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

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

// Poll a condition until it returns a truthy value, with timeout.
// Returns the truthy value, or throws on timeout.
async function poll(
  checkFn,
  { interval = 1000, timeout = 300000, initialDelay = 0, label = "poll" } = {},
) {
  if (initialDelay > 0) await new Promise((r) => setTimeout(r, initialDelay));
  const start = Date.now();
  while (true) {
    const result = await checkFn();
    if (result) return result;
    if (Date.now() - start >= timeout) throw new Error(`Timeout: ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Track file watchers and which session each window is viewing
const fileWatchers = new Map();
let mainWindow = null;

// Cache origin per PID (never changes during a process's lifetime)
const originCache = new Map();

// Cache getSessions() results with TTL to avoid redundant subprocess calls
let sessionsCache = null;
let sessionsCacheTs = 0;
const SESSIONS_CACHE_TTL = 2000; // 2 seconds

// Cache git root lookups (cwd -> gitRoot)
const gitRootCache = new Map();

// Cache JSONL path lookups (sessionId -> path)
const jsonlPathCache = new Map();

// If a "processing" session's transcript size hasn't changed in this long, treat as idle
const STALE_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes

// Track stale sessions to detect transitions (stale → not-stale)
const staleLoggedSessions = new Set();

// Track last-seen JSONL file sizes and when they last changed (sessionId -> { size, changedAt })
const jsonlSizeTracker = new Map();
// Terminal input detection via buffer parsing (true ground truth).
// Cached results refreshed by pollTerminalInput() every TERMINAL_POLL_MS.
const terminalHasInputCache = new Map(); // termId → input text string
const {
  parseTerminalHasInput,
  checkTerminalInputs,
} = require("./terminal-input");
const TERMINAL_POLL_MS = 10_000;
const TERMINAL_WRITE_DEBOUNCE_MS = 500;

// Poll fresh pool slots for terminal input by parsing their PTY buffers.
// Runs periodically to keep terminalHasInputCache in sync with ground truth.
// Uses `list` (returns all PTY buffers in one call) instead of per-slot
// `read-buffer` to work with any daemon version.
let pollInFlight = false;
async function pollTerminalInput() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const pool = readPool();
    if (!pool) return;

    const freshSlots = pool.slots.filter((s) => s.status === POOL_STATUS.FRESH);
    if (freshSlots.length === 0) return;

    // Single daemon call to get all terminal buffers
    let ptys;
    try {
      const resp = await daemonRequest({ type: "list" });
      ptys = resp.ptys || [];
    } catch (err) {
      debugLog("main", "pollTerminalInput: daemon unavailable", err.message);
      return;
    }

    const freshTermIds = new Set(freshSlots.map((s) => s.termId));
    const ptyTermIds = new Set(ptys.map((p) => p.termId));
    const results = await checkTerminalInputs(ptys, freshTermIds);

    let changed = false;
    for (const [termId, inputText] of results) {
      const prev = terminalHasInputCache.get(termId) || "";
      if (inputText !== prev) {
        if (inputText) {
          terminalHasInputCache.set(termId, inputText);
        } else {
          terminalHasInputCache.delete(termId);
        }
        changed = true;
      }
    }

    // Clear stale cache entries for fresh slots whose PTY disappeared
    for (const termId of freshTermIds) {
      if (!ptyTermIds.has(termId) && terminalHasInputCache.has(termId)) {
        terminalHasInputCache.delete(termId);
        changed = true;
      }
    }

    if (changed) {
      invalidateSessionsCache();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("sessions-changed");
      }
    }
  } finally {
    pollInFlight = false;
  }
}

// Trigger a poll shortly after a keystroke is written to a fresh pool terminal.
// Debounced so rapid typing doesn't flood — only the trailing edge fires.
// Pool check is inside the callback to avoid disk I/O on every keystroke.
let writeDebounceTimer = null;
function triggerPollOnWrite(termId) {
  clearTimeout(writeDebounceTimer);
  writeDebounceTimer = setTimeout(() => {
    const pool = readPool();
    if (!pool) return;
    const slot = pool.slots.find(
      (s) => s.termId === termId && s.status === POOL_STATUS.FRESH,
    );
    if (!slot) return;
    pollTerminalInput().catch((err) =>
      debugLog(
        "main",
        "pollTerminalInput (write-triggered) failed",
        err.message,
      ),
    );
  }, TERMINAL_WRITE_DEBOUNCE_MS);
}

function freshOrTyping(hasIntentionContent, hasTermInput) {
  return hasIntentionContent || hasTermInput ? STATUS.TYPING : STATUS.FRESH;
}

// Cache transcriptContains results (key -> true, once true stays true)
const transcriptCache = new Map();

// Sessions that have been through at least one processing cycle (non-pool-init).
// Once activated, a session should never fall back to fresh/typing classification.
const activatedSessions = new Set();

// Idle signal triggers that represent fresh/unactivated sessions.
// Signals with these triggers do NOT mark a session as activated.
const FRESH_TRIGGERS = new Set(["pool-init", "session-clear"]);

const { parseOrigins } = require("./parse-origins");

// Detect session origin by reading process environment via ps eww (macOS).
// Batched: resolves all uncached PIDs in a single subprocess call.
async function batchDetectOrigins(pids) {
  const results = new Map();
  const uncached = [];
  for (const pid of pids) {
    const key = String(pid);
    if (originCache.has(key)) {
      results.set(key, originCache.get(key));
    } else {
      uncached.push(key);
    }
  }
  if (uncached.length > 0) {
    try {
      const { stdout } = await execFileAsync(
        "ps",
        ["eww", "-p", uncached.join(",")],
        { encoding: "utf-8", timeout: 3000 },
      );
      const parsed = parseOrigins(stdout, uncached);
      for (const [pid, origin] of parsed) {
        originCache.set(pid, origin);
        results.set(pid, origin);
      }
    } catch (err) {
      console.error(
        "[main] Failed to detect session origins via ps:",
        err.message,
      );
      for (const pid of uncached) {
        originCache.set(pid, "ext");
        results.set(pid, "ext");
      }
    }
  }
  return results;
}

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
  // Maps input-event action IDs to IPC channels
  const inputEventChannels = {
    "next-terminal-tab-alt": "next-terminal-tab",
    "prev-terminal-tab-alt": "prev-terminal-tab",
    "next-session": "next-session",
    "prev-session": "prev-session",
    "cycle-pane": "cycle-pane",
  };

  mainWindow.webContents.on("before-input-event", (event, input) => {
    // Escape — focus terminal (only when not in command palette)
    if (input.key === "Escape" && !input.meta && !input.control && !input.alt) {
      mainWindow.webContents.send("focus-terminal");
      return;
    }

    // Check all input-event-based shortcuts (uses pre-parsed cache)
    const matchedAction = findMatchingInputAction(input);
    if (matchedAction) {
      event.preventDefault();
      const channel = inputEventChannels[matchedAction] || matchedAction;
      mainWindow.webContents.send(channel);
    }
  });

  mainWindow.webContents.on("console-message", (_e, level, message) => {
    console.log(`[renderer] ${message}`);
  });
}

async function findJsonlPath(sessionId) {
  if (jsonlPathCache.has(sessionId)) return jsonlPathCache.get(sessionId);
  try {
    const { stdout: findOut } = await execFileAsync(
      "find",
      [CLAUDE_PROJECTS_DIR, "-name", `${sessionId}.jsonl`],
      { encoding: "utf-8", timeout: 5000 },
    );
    const jsonlPath = findOut.split("\n")[0].trim();
    if (jsonlPath) jsonlPathCache.set(sessionId, jsonlPath);
    return jsonlPath || null;
  } catch (err) {
    console.error(
      "[main] Failed to find JSONL path for session",
      sessionId,
      err.message,
    );
    return null;
  }
}

// Use file SIZE (not mtime) for stale detection. Claude keeps the JSONL file
// handle open, causing periodic mtime updates without new content. Size only
// changes when actual entries are appended.
async function getJsonlSize(sessionId) {
  let jsonlPath = jsonlPathCache.get(sessionId);
  if (!jsonlPath) jsonlPath = await findJsonlPath(sessionId);
  if (!jsonlPath) return null;
  try {
    const stat = await fs.promises.stat(jsonlPath);
    return stat.size;
  } catch {
    /* ENOENT expected — file may have been removed between find and stat */
    jsonlPathCache.delete(sessionId);
    return null;
  }
}

async function getCwdFromJsonl(sessionId) {
  try {
    const jsonlPath = await findJsonlPath(sessionId);
    if (!jsonlPath) return null;

    const { stdout: tail } = await execFileAsync("tail", ["-100", jsonlPath], {
      encoding: "utf-8",
      timeout: 3000,
    });
    let cwd = "";
    for (const line of tail.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd) cwd = obj.cwd;
      } catch {
        /* malformed JSONL lines expected */
      }
    }
    return cwd || null;
  } catch (err) {
    debugLog("main", "getCwdFromJsonl failed for", sessionId, err.message);
    return null;
  }
}

async function getIntentionHeading(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    /* ENOENT expected — intention file may not exist yet */
    return null;
  }
}

// Read idle signal for a PID. Returns {cwd, ts, trigger, session_id, transcript} or null.
async function getIdleSignal(pid) {
  try {
    const signalFile = path.join(IDLE_SIGNALS_DIR, String(pid));
    const parsed = JSON.parse(await fs.promises.readFile(signalFile, "utf-8"));
    return parsed;
  } catch {
    /* ENOENT expected — no idle signal means session is processing */
    return null;
  }
}

// Check if a JSONL transcript contains a given needle string.
// Reads in 64KB chunks to avoid loading the entire file into memory.
async function transcriptContains(transcriptPath, needle) {
  if (!transcriptPath) return false;
  const cacheKey = transcriptPath + "\0" + needle;
  if (transcriptCache.get(cacheKey)) return true;
  try {
    const fh = await fs.promises.open(transcriptPath, "r");
    const buf = Buffer.alloc(64 * 1024); // 64KB chunks
    let offset = 0;
    let overlap = ""; // Keep tail of previous chunk to catch boundary-spanning needles
    try {
      let result;
      while (
        (result = await fh.read(buf, 0, buf.length, offset)) &&
        result.bytesRead > 0
      ) {
        const chunk = buf.toString("utf-8", 0, result.bytesRead);
        if ((overlap + chunk).includes(needle)) {
          transcriptCache.set(cacheKey, true);
          return true;
        }
        overlap = chunk.slice(-(needle.length - 1));
        offset += result.bytesRead;
      }
    } finally {
      await fh.close();
    }
    return false;
  } catch {
    /* ENOENT expected — transcript may not exist yet */
    return false;
  }
}

// Read offloaded session metadata
async function getOffloadedSessions() {
  let dirs;
  try {
    dirs = await fs.promises.readdir(OFFLOADED_DIR);
  } catch {
    return [];
  }
  const sessions = [];
  for (const dir of dirs) {
    try {
      const meta = readOffloadMeta(dir);
      if (!meta) continue;
      const snapshotFile = path.join(OFFLOADED_DIR, dir, "snapshot.log");
      const hasSnapshot = fs.existsSync(snapshotFile);

      // Delete empty sessions (no snapshot + no intention) — they were never used
      if (!hasSnapshot && !meta.intentionHeading) {
        try {
          fs.rmSync(path.join(OFFLOADED_DIR, dir), { recursive: true });
          // Clean up empty intention file if it exists
          const intentionPath = path.join(INTENTIONS_DIR, `${dir}.md`);
          try {
            const stat = fs.statSync(intentionPath);
            if (stat.size === 0) fs.unlinkSync(intentionPath);
          } catch {
            /* no file or non-empty */
          }
        } catch (err) {
          debugLog(
            "main",
            "failed to clean up empty session",
            dir,
            err.message,
          );
        }
        continue;
      }

      // Sessions without a snapshot can't be meaningfully resumed — treat as archived
      const isArchived = meta.archived || !hasSnapshot;
      if (!meta.archived && !hasSnapshot) {
        // Persist the archived flag so this doesn't recompute every time
        meta.archived = true;
        meta.archivedAt = meta.archivedAt || new Date().toISOString();
        try {
          secureWriteFileSync(
            path.join(OFFLOADED_DIR, dir, "meta.json"),
            JSON.stringify(meta, null, 2),
          );
        } catch (err) {
          console.error(
            "[main] Failed to auto-archive stale session",
            dir,
            err.message,
          );
        }
      }
      sessions.push({
        pid: null,
        sessionId: meta.sessionId || dir,
        alive: false,
        cwd: meta.cwd || null,
        home: os.homedir(),
        gitRoot: meta.gitRoot || null,
        project: meta.cwd ? path.basename(meta.cwd) : null,
        hasIntention: meta.intentionHeading != null,
        intentionHeading: meta.intentionHeading || null,
        status: isArchived ? STATUS.ARCHIVED : STATUS.OFFLOADED,
        idleTs: meta.lastInteractionTs || 0,
        claudeSessionId: meta.claudeSessionId || null,
        hasSnapshot,
        origin: meta.origin || null,
      });
    } catch (err) {
      debugLog(
        "main",
        "getOffloadedSessions: failed to read session",
        dir,
        err.message,
      );
    }
  }
  return sessions;
}

async function findGitRoot(cwd) {
  if (!cwd) return null;
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    try {
      if ((await fs.promises.stat(dotGit)).isDirectory()) {
        gitRootCache.set(cwd, dir);
        return dir;
      }
    } catch {
      /* ENOENT expected — .git doesn't exist at this level */
    }
    dir = path.dirname(dir);
  }
  gitRootCache.set(cwd, null);
  return null;
}

// Batch lsof: get CWDs for all PIDs in one call (async, non-blocking)
async function batchGetCwds(pids) {
  const cwdMap = new Map();
  if (pids.length === 0) return cwdMap;
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-p", pids.join(","), "-d", "cwd", "-F", "pn"],
      { encoding: "utf-8", timeout: 5000 },
    );
    // Parse lsof -F pn output: lines starting with 'p' = PID, 'n' = path
    let currentPid = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = line.slice(1);
      } else if (line.startsWith("n") && currentPid) {
        cwdMap.set(currentPid, line.slice(1));
      }
    }
  } catch (err) {
    console.error("[main] lsof failed to resolve session cwds:", err.message);
  }
  return cwdMap;
}

async function getSessionsUncached() {
  const sessions = [];
  const pool = readPool();
  // Pre-build session→slot map for O(1) lookups
  const poolSlotMap = new Map();
  if (pool) {
    for (const slot of pool.slots) {
      if (slot.sessionId) poolSlotMap.set(slot.sessionId, slot);
    }
  }

  // Live sessions from session-pids
  const pidEntries = []; // {pid, sessionId}
  if (fs.existsSync(SESSION_PIDS_DIR)) {
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
        /* ESRCH expected — process doesn't exist */
        alive = false;
      }

      pidEntries.push({ pid, sessionId, alive });
    }
  }

  // Batch lsof for all alive PIDs (single subprocess instead of N)
  const alivePids = pidEntries.filter((e) => e.alive).map((e) => e.pid);
  const cwdMap = await batchGetCwds(alivePids);

  for (const { pid, sessionId, alive } of pidEntries) {
    let cwd = alive ? cwdMap.get(String(pid)) || null : null;

    // Refine CWD via JSONL when lsof reports a generic directory
    if (!cwd || cwd === os.homedir() || cwd === "/") {
      const refined = await getCwdFromJsonl(sessionId);
      if (refined && fs.existsSync(refined) && refined !== os.homedir()) {
        cwd = refined;
      }
    }

    const intentionFile = path.join(INTENTIONS_DIR, `${sessionId}.md`);
    const hasIntention = fs.existsSync(intentionFile);

    // Run independent I/O in parallel
    const [intentionHeading, gitRoot, rawIdleSignal] = await Promise.all([
      hasIntention ? getIntentionHeading(intentionFile) : null,
      findGitRoot(cwd),
      alive ? getIdleSignal(pid) : null,
    ]);
    // Discard stale idle signals left by a previous session on the same PID
    // (e.g. after manual /clear before the session-clear hook overwrites it).
    // Keep signals with no session_id (backward compat with older hook versions).
    const idleSignal =
      !rawIdleSignal?.session_id || rawIdleSignal.session_id === sessionId
        ? rawIdleSignal
        : null;
    let status;
    let idleTs = 0;
    let staleIdle = false;
    const poolSlot = poolSlotMap.get(sessionId);
    // Only check intention content for pool sessions (avoids unnecessary file reads for external/idle)
    const intentionContent = poolSlot ? readIntention(sessionId).trim() : "";
    const hasIntentionContent = !!intentionContent;
    const hasTermInput = !!(
      poolSlot && terminalHasInputCache.get(poolSlot.termId)
    );

    // Track activation: triggers NOT in FRESH_TRIGGERS mean the session has
    // been through a real processing cycle and should never revert to fresh/typing.
    if (
      idleSignal &&
      idleSignal.trigger &&
      !FRESH_TRIGGERS.has(idleSignal.trigger)
    ) {
      activatedSessions.add(sessionId);
    }
    const isActivated = activatedSessions.has(sessionId);

    if (!alive) {
      status = STATUS.DEAD;
    } else if (idleSignal) {
      // IMPORTANT: Idle signal presence = session is idle. No false positives allowed.
      // This is safe because UserPromptSubmit always clears the signal before
      // processing begins, including cycles where Stop hooks re-prompt Claude.
      // We intentionally do NOT compare transcript mtime with signal mtime here:
      // local commands (e.g. /model, /help) write to the JSONL without triggering
      // hooks, which would cause permanent false "processing" detection.
      idleTs = idleSignal.ts || 0;
      // "assistant" needle: post-/clear transcripts have "user" entries from
      // local-command metadata but never assistant responses.
      if (
        isActivated ||
        (await transcriptContains(idleSignal.transcript, '"type":"assistant"'))
      ) {
        status = STATUS.IDLE;
      } else {
        status = freshOrTyping(hasIntentionContent, hasTermInput);
      }
    } else {
      // Fallback: if transcript size hasn't changed in a while, treat as idle.
      // Uses file SIZE (not mtime) because Claude keeps the JSONL file handle open,
      // causing mtime updates even without new content.
      const size = await getJsonlSize(sessionId);
      const now = Date.now();
      let unchangedSince = now;

      if (size != null) {
        const tracked = jsonlSizeTracker.get(sessionId);
        if (tracked && tracked.size === size) {
          unchangedSince = tracked.changedAt;
        } else {
          jsonlSizeTracker.set(sessionId, { size, changedAt: now });
        }
      }

      if (size != null && now - unchangedSince > STALE_PROCESSING_MS) {
        // Always log — stale sessions indicate a hook failure and should never happen
        console.error(
          `[main] Stale processing detected for session ${sessionId} (transcript size unchanged for ${Math.round((now - unchangedSince) / 1000)}s) — treating as idle. Idle signal hook may have failed.`,
        );
        staleLoggedSessions.add(sessionId);
        status = STATUS.IDLE;
        staleIdle = true;
        idleTs = Math.round(unchangedSince / 1000);
      } else {
        if (staleLoggedSessions.delete(sessionId)) {
          console.log(
            `[main] Session ${sessionId} is no longer stale (resumed processing).`,
          );
        }
        const jsonlPath = jsonlPathCache.get(sessionId);
        if (isActivated) {
          status = STATUS.PROCESSING;
        } else {
          // "user" needle: this path only runs when idle signal is absent
          // (prompt just submitted), so "user" entries are real, not /clear artifacts.
          status = (await transcriptContains(jsonlPath, '"type":"user"'))
            ? STATUS.PROCESSING
            : freshOrTyping(hasIntentionContent, hasTermInput);
        }
      }
    }

    // Build a preview of typed text for "typing" sessions with no heading
    let intentionPreview = null;
    if (status === STATUS.TYPING && !intentionHeading) {
      if (intentionContent) {
        // Strip markdown heading if present (shouldn't be, but defensive)
        const preview = intentionContent.replace(/^#\s+.*\n?/, "").trim();
        if (preview) intentionPreview = preview.slice(0, 80);
      }
      if (!intentionPreview && hasTermInput) {
        const termText = poolSlot
          ? terminalHasInputCache.get(poolSlot.termId)
          : null;
        if (termText) intentionPreview = termText.slice(0, 80);
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
      intentionPreview,
      status,
      intentionHasContent: hasIntentionContent,
      terminalHasInput: hasTermInput,
      idleTs,
      staleIdle,
    });
  }

  // Deduplicate: if multiple PIDs map to the same sessionId, keep the best one
  // (prefer alive over dead, then highest PID). Remove dominated PID files from disk.
  const bySessionId = new Map();
  for (const s of sessions) {
    const existing = bySessionId.get(s.sessionId);
    if (!existing) {
      bySessionId.set(s.sessionId, s);
      continue;
    }
    // Determine winner: alive beats dead, then highest PID wins
    let dominated;
    if (existing.alive !== s.alive) {
      dominated = existing.alive ? s : existing;
    } else {
      dominated = Number(existing.pid) >= Number(s.pid) ? s : existing;
    }
    const winner = dominated === s ? existing : s;
    bySessionId.set(s.sessionId, winner);
    // Remove dominated PID file from disk
    try {
      fs.unlinkSync(path.join(SESSION_PIDS_DIR, String(dominated.pid)));
    } catch (err) {
      debugLog(
        "main",
        "failed to remove dominated PID file",
        dominated.pid,
        err.message,
      );
    }
  }
  const dedupedSessions = [...bySessionId.values()];
  sessions.length = 0;
  sessions.push(...dedupedSessions);

  // Archive dead sessions (save as archived without snapshot)
  const poolForArchive = readPool();
  const poolSessionIdsForArchive = new Set();
  if (poolForArchive) {
    for (const slot of poolForArchive.slots) {
      if (slot.sessionId) poolSessionIdsForArchive.add(slot.sessionId);
    }
  }
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.status !== STATUS.DEAD) continue;

    const offloadDir = path.join(OFFLOADED_DIR, s.sessionId);
    if (!fs.existsSync(offloadDir)) {
      // Skip archiving sessions that were never used (no intention = no user prompt)
      if (!s.intentionHeading) {
        try {
          fs.unlinkSync(path.join(SESSION_PIDS_DIR, String(s.pid)));
        } catch (err) {
          debugLog(
            "main",
            "failed to remove dead PID file",
            s.pid,
            err.message,
          );
        }
        // Clean up empty intention file if it exists
        try {
          const intentionPath = path.join(INTENTIONS_DIR, `${s.sessionId}.md`);
          const stat = fs.statSync(intentionPath);
          if (stat.size === 0) fs.unlinkSync(intentionPath);
        } catch {
          /* no intention file or non-empty — fine */
        }
        sessions.splice(i, 1);
        continue;
      }

      // Recover cwd from JSONL since lsof doesn't work on dead processes
      let cwd = s.cwd || (await getCwdFromJsonl(s.sessionId));
      let gitRoot = s.gitRoot || (await findGitRoot(cwd));
      const origin = poolSessionIdsForArchive.has(s.sessionId) ? "pool" : "ext";

      secureMkdirSync(offloadDir, { recursive: true });
      const meta = {
        sessionId: s.sessionId,
        claudeSessionId: s.sessionId,
        cwd: cwd || null,
        gitRoot: gitRoot || null,
        intentionHeading: s.intentionHeading,
        lastInteractionTs: Math.floor(Date.now() / 1000),
        archivedAt: new Date().toISOString(),
        archived: true,
        origin,
      };
      secureWriteFileSync(
        path.join(offloadDir, "meta.json"),
        JSON.stringify(meta, null, 2),
      );
    } else {
      // Offload dir exists (session was offloaded before dying) — ensure archived
      const existingMeta = readOffloadMeta(s.sessionId);
      if (existingMeta && !existingMeta.archived) {
        existingMeta.archived = true;
        existingMeta.archivedAt =
          existingMeta.archivedAt || new Date().toISOString();
        secureWriteFileSync(
          path.join(offloadDir, "meta.json"),
          JSON.stringify(existingMeta, null, 2),
        );
      }
    }

    // Clean up stale PID file
    try {
      fs.unlinkSync(path.join(SESSION_PIDS_DIR, String(s.pid)));
    } catch (err) {
      debugLog("main", "failed to remove dead PID file", s.pid, err.message);
    }

    sessions.splice(i, 1);
  }

  // Tag sessions with origin: pool, sub-claude, or ext
  const poolSessionIds = new Set();
  if (pool) {
    for (const slot of pool.slots) {
      if (slot.sessionId) poolSessionIds.add(slot.sessionId);
    }
  }
  // Batch detect origins for all alive non-pool sessions in one ps call
  const needOriginPids = sessions
    .filter((s) => s.alive && !poolSessionIds.has(s.sessionId))
    .map((s) => s.pid);
  const originMap = await batchDetectOrigins(needOriginPids);
  for (const s of sessions) {
    if (poolSessionIds.has(s.sessionId)) {
      s.origin = "pool";
    } else if (s.alive) {
      s.origin = originMap.get(String(s.pid)) || "ext";
    } else {
      s.origin = "ext";
    }
  }

  // Annotate pool sessions with their pool slot status so the renderer
  // can detect fresh slots without a separate poolRead() call.
  if (pool) {
    const slotMap = new Map(
      pool.slots.filter((s) => s.sessionId).map((s) => [s.sessionId, s.status]),
    );
    for (const s of sessions) {
      const slotStatus = slotMap.get(s.sessionId);
      if (slotStatus) s.poolStatus = slotStatus;
    }
  }

  // Prune stale tracker entries for sessions that no longer exist
  const liveIds = new Set(sessions.map((s) => s.sessionId));
  for (const id of jsonlSizeTracker.keys()) {
    if (!liveIds.has(id)) jsonlSizeTracker.delete(id);
  }
  for (const id of activatedSessions) {
    if (!liveIds.has(id)) activatedSessions.delete(id);
  }
  for (const key of transcriptCache.keys()) {
    const sessionId = path.basename(key.split("\0")[0], ".jsonl");
    if (sessionId && !liveIds.has(sessionId)) transcriptCache.delete(key);
  }

  // Add offloaded/archived sessions, skip if live session exists.
  // If a live session has the same ID as an offloaded one (e.g. /clear kept
  // the same UUID), remove the stale offload data from disk.
  for (const offloaded of await getOffloadedSessions()) {
    if (!liveIds.has(offloaded.sessionId)) {
      if (!offloaded.origin) offloaded.origin = "pool";
      sessions.push(offloaded);
    } else if (!offloaded.archived) {
      // Live session supersedes non-archived offload data — clean up
      removeOffloadData(offloaded.sessionId);
    }
  }

  return sortSessions(sessions);
}

// In-flight promise to prevent concurrent getSessions() calls from spawning
// duplicate subprocesses. Second caller reuses the first's result.
let sessionsInFlight = null;

// Lightweight fingerprint: PID files + idle signal mtimes + offloaded dir.
// Avoids expensive subprocess calls when nothing changed.
let lastDirFingerprint = null;
let lastFullRefreshTs = 0;
const MAX_FINGERPRINT_AGE = 30000; // Force full refresh every 30s for liveness checks

function computeDirFingerprint() {
  try {
    const parts = [];
    // PID files (session-pids dir)
    if (fs.existsSync(SESSION_PIDS_DIR)) {
      const files = fs.readdirSync(SESSION_PIDS_DIR).sort();
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(SESSION_PIDS_DIR, f));
          parts.push(`p:${f}:${st.mtimeMs}`);
        } catch {
          /* ENOENT — file removed between readdir and stat */
        }
      }
    }
    // Idle signal files
    if (fs.existsSync(IDLE_SIGNALS_DIR)) {
      const files = fs.readdirSync(IDLE_SIGNALS_DIR).sort();
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(IDLE_SIGNALS_DIR, f));
          parts.push(`i:${f}:${st.mtimeMs}`);
        } catch {
          /* ENOENT — file removed between readdir and stat */
        }
      }
    }
    // Offloaded dir mtime (catches new archives)
    try {
      const st = fs.statSync(OFFLOADED_DIR);
      parts.push(`o:${st.mtimeMs}`);
    } catch {
      /* ENOENT — dir may not exist yet */
    }
    // Pool state changes (new slots, killed sessions)
    try {
      const st = fs.statSync(POOL_FILE);
      parts.push(`pool:${st.mtimeMs}`);
    } catch {
      /* ENOENT — pool may not be initialized */
    }
    return parts.join("|");
  } catch {
    return null; // Force refresh on error
  }
}

async function getSessions() {
  const now = Date.now();
  if (sessionsCache && now - sessionsCacheTs < SESSIONS_CACHE_TTL) {
    return sessionsCache;
  }

  // Fast path: if directory state hasn't changed and not too stale, extend cache.
  // Max age ensures dead processes are detected even when their PID files remain.
  const fp = computeDirFingerprint();
  if (
    sessionsCache &&
    fp &&
    fp === lastDirFingerprint &&
    now - lastFullRefreshTs < MAX_FINGERPRINT_AGE
  ) {
    sessionsCacheTs = now;
    return sessionsCache;
  }

  // Deduplicate concurrent calls
  if (sessionsInFlight) return sessionsInFlight;
  sessionsInFlight = getSessionsUncached()
    .then((result) => {
      sessionsCache = result;
      sessionsCacheTs = Date.now();
      lastFullRefreshTs = Date.now();
      lastDirFingerprint = computeDirFingerprint();
      return result;
    })
    .finally(() => {
      sessionsInFlight = null;
    });
  return sessionsInFlight;
}

// Invalidate sessions cache (call after mutations like offload, pool changes)
function invalidateSessionsCache() {
  sessionsCache = null;
  sessionsCacheTs = 0;
  lastDirFingerprint = null;
  lastFullRefreshTs = 0;
}

// Read the terminal buffer for a single PTY (lightweight alternative to list)
async function readTerminalBuffer(termId) {
  try {
    const resp = await daemonRequest({ type: "read-buffer", termId });
    return resp.buffer || "";
  } catch {
    /* daemon may be disconnected — return empty buffer */
    return "";
  }
}

// Strip ANSI escape codes and normalize line endings.
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\x1b\[?\??[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b[>=]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// Wait until the terminal buffer's tail contains the given text (or timeout).
// Only checks the last portion of the buffer to avoid false-matching scrollback.
async function waitForBufferContent(termId, text, timeoutMs = 3000) {
  const tailSize = text.length + 500; // enough for the input line + prompt
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const buffer = await readTerminalBuffer(termId);
    const tail = buffer.length > tailSize ? buffer.slice(-tailSize) : buffer;
    if (tail.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Send a command to a terminal: Escape → Ctrl-U → command + Enter
// Uses buffer polling to confirm each step rendered before proceeding.
// Throws if the daemon socket is not connected.
async function sendCommandToTerminal(termId, command) {
  daemonSend({ type: "write", termId, data: "\x1b" });
  await new Promise((r) => setTimeout(r, 200));
  daemonSend({ type: "write", termId, data: "\x15" }); // Ctrl-U
  await new Promise((r) => setTimeout(r, 100));
  daemonSend({ type: "write", termId, data: command });
  await waitForBufferContent(termId, command);
  daemonSend({ type: "write", termId, data: "\r" });
}

// Create a fresh idle signal file for a pool slot
function createFreshIdleSignal(pid, sessionId) {
  secureMkdirSync(IDLE_SIGNALS_DIR, { recursive: true });
  secureWriteFileSync(
    path.join(IDLE_SIGNALS_DIR, String(pid)),
    JSON.stringify({
      cwd: os.homedir(),
      session_id: sessionId,
      transcript: "",
      ts: Math.floor(Date.now() / 1000),
      trigger: "pool-init",
    }),
  );
}

// Sort: recent (idle+offloaded, limit 10) → processing → fresh/dead hidden
// Pool and external sessions are mixed together in the same sections.
// Offload a session: save snapshot + meta, then send /clear to terminal
async function offloadSession(
  sessionId,
  termId,
  claudeSessionId,
  { cwd, gitRoot, pid } = {},
) {
  // Get terminal buffer and render to readable text
  let snapshot = null;
  try {
    const resp = await daemonRequest({ type: "list" });
    const pty = resp.ptys.find((p) => p.termId === termId);
    if (pty && pty.buffer) snapshot = await renderBufferToText(pty.buffer);
  } catch (err) {
    console.error(
      "[main] Failed to get terminal snapshot for offload of session",
      sessionId,
      err.message,
    );
  }

  const meta = await writeOffloadMeta(sessionId, {
    cwd,
    gitRoot,
    claudeSessionId,
    snapshot,
    origin: "pool",
  });
  // Clean up terminal input cache for the offloaded slot
  if (termId) terminalHasInputCache.delete(termId);

  // Send /clear to the terminal to free the slot (mirroring sub-Claude's offload flow)
  try {
    await sendCommandToTerminal(termId, "/clear");
  } catch (err) {
    console.warn(
      `[offload] Failed to send /clear for session ${sessionId}: ${err.message}`,
    );
  }

  // 3. Remove idle signal so session re-detects as fresh after /clear
  if (pid) {
    const idleSignalFile = path.join(IDLE_SIGNALS_DIR, String(pid));
    try {
      fs.unlinkSync(idleSignalFile);
    } catch {
      /* ENOENT race — signal may already be removed */
    }
    // Remove stale PID file so the old session doesn't appear as a live "idle"
    // ghost while /clear is in flight. The SessionStart hook will recreate it
    // with the new session UUID once /clear completes.
    try {
      fs.unlinkSync(path.join(SESSION_PIDS_DIR, String(pid)));
    } catch {
      /* ENOENT race — PID file may already be removed */
    }
  }

  // 4. Update pool slot: /clear keeps same PID but assigns a new session UUID
  let slotRef;
  await withPoolLock(() => {
    const pool = readPool();
    if (!pool) return;
    const slot = pool.slots.find((s) => s.termId === termId);
    if (!slot) return;
    slotRef = { termId: slot.termId, pid: slot.pid, excludeId: slot.sessionId };
    slot.status = POOL_STATUS.STARTING;
    slot.sessionId = null;
    writePool(pool);
  });

  // Track slot in background (session ID polling after /clear)
  if (slotRef) {
    trackNewSlot(
      { termId: slotRef.termId, pid: slotRef.pid },
      { excludeId: slotRef.excludeId, skipTrustPrompt: true },
    );
  }

  return meta;
}

// Validate sessionId format to prevent path traversal
function validateSessionId(sessionId) {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    throw new Error("Invalid session ID format");
  }
}

// --- Session graph (parent-child tracking) ---

function readSessionGraph() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_GRAPH_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeSessionGraph(graph) {
  const data = JSON.stringify(graph, null, 2);
  const tmp = SESSION_GRAPH_FILE + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, SESSION_GRAPH_FILE);
}

function recordSessionRelation(sessionId, parentSessionId, initiator) {
  const graph = readSessionGraph();
  graph[sessionId] = {
    parentSessionId: parentSessionId || null,
    initiator: initiator || "user",
    createdAt: new Date().toISOString(),
  };
  writeSessionGraph(graph);
}

function enrichSessionsWithGraphData(sessions) {
  const graph = readSessionGraph();
  for (const s of sessions) {
    const rel = graph[s.sessionId];
    if (rel) {
      s.parentSessionId = rel.parentSessionId;
      s.initiator = rel.initiator;
    }
  }
}

// Render raw PTY buffer into readable screen text using a headless terminal.
async function renderBufferToText(buffer, cols = 200) {
  if (!buffer) return null;
  const term = new HeadlessTerminal({
    cols,
    rows: 500,
    scrollback: 5000,
    allowProposedApi: true,
  });
  await new Promise((resolve) => term.write(buffer, resolve));
  const lines = [];
  const buf = term.buffer.active;
  // Only read up to the last non-empty line
  let lastNonEmpty = -1;
  for (let i = buf.length - 1; i >= 0; i--) {
    const line = buf.getLine(i);
    if (line && line.translateToString(true).trim()) {
      lastNonEmpty = i;
      break;
    }
  }
  for (let i = 0; i <= lastNonEmpty; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  term.dispose();
  return lines.join("\n");
}

// Write offload metadata (and optional snapshot) to disk for a session.
async function writeOffloadMeta(
  sessionId,
  { cwd, gitRoot, claudeSessionId, snapshot, externalClear, origin } = {},
) {
  validateSessionId(sessionId);
  const offloadDir = path.join(OFFLOADED_DIR, sessionId);
  secureMkdirSync(offloadDir, { recursive: true });

  if (snapshot) {
    secureWriteFileSync(path.join(offloadDir, "snapshot.log"), snapshot);
  }

  const intentionFile = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  const intentionHeading = fs.existsSync(intentionFile)
    ? await getIntentionHeading(intentionFile)
    : null;

  const meta = {
    sessionId,
    claudeSessionId: claudeSessionId || null,
    cwd: cwd || null,
    gitRoot: gitRoot || null,
    intentionHeading,
    lastInteractionTs: Math.floor(Date.now() / 1000),
    offloadedAt: new Date().toISOString(),
  };
  if (externalClear) meta.externalClear = true;
  if (origin) meta.origin = origin;

  secureWriteFileSync(
    path.join(offloadDir, "meta.json"),
    JSON.stringify(meta, null, 2),
  );

  return meta;
}

// Save offload metadata for a session that was cleared externally (e.g. /clear in terminal)
async function saveExternalClearOffload(oldSessionId, pid) {
  validateSessionId(oldSessionId);
  const offloadDir = path.join(OFFLOADED_DIR, oldSessionId);
  if (fs.existsSync(offloadDir)) return; // already offloaded

  // Gather what metadata we can
  let cwd = null;
  if (pid) {
    try {
      const lsof = execFileSync(
        "lsof",
        ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
      );
      const m = lsof.match(/^n(.+)$/m);
      if (m) cwd = m[1];
    } catch (err) {
      console.error(
        "[main] lsof failed to resolve cwd for PID",
        pid,
        err.message,
      );
    }
  }

  await writeOffloadMeta(oldSessionId, {
    cwd,
    externalClear: true,
    origin: "ext",
  });
}

// Archive a session: mark its offload meta as archived.
// For live pool sessions, offload first (snapshot + /clear), then mark archived.
// For already-offloaded sessions, just flip the archived flag.
async function archiveSession(sessionId) {
  validateSessionId(sessionId);
  const meta = readOffloadMeta(sessionId);
  if (meta) {
    // Already offloaded — just mark as archived
    meta.archived = true;
    meta.archivedAt = meta.archivedAt || new Date().toISOString();
    secureWriteFileSync(
      path.join(OFFLOADED_DIR, sessionId, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
    sessionsCache = null;
    return;
  }

  // Live session — need to offload first if it's a pool session
  const pool = readPool();
  const slot = pool?.slots?.find((s) => s.sessionId === sessionId);
  if (slot) {
    // Pool session: offload it first, then mark archived
    const sessions = await getSessionsUncached();
    const session = sessions.find((s) => s.sessionId === sessionId);
    await offloadSession(sessionId, slot.termId, sessionId, {
      cwd: session?.cwd,
      gitRoot: session?.gitRoot,
      pid: session?.pid,
    });
    // Poll for offload meta to be written (up to 5s)
    for (let i = 0; i < 50; i++) {
      if (readOffloadMeta(sessionId)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Mark as archived (may have been just written by offloadSession)
  const updatedMeta = readOffloadMeta(sessionId);
  if (updatedMeta) {
    updatedMeta.archived = true;
    updatedMeta.archivedAt = updatedMeta.archivedAt || new Date().toISOString();
    secureWriteFileSync(
      path.join(OFFLOADED_DIR, sessionId, "meta.json"),
      JSON.stringify(updatedMeta, null, 2),
    );
  } else {
    // No offload data yet — create archive-only meta
    const offloadDir = path.join(OFFLOADED_DIR, sessionId);
    secureMkdirSync(offloadDir, { recursive: true });
    const intentionFile = path.join(INTENTIONS_DIR, `${sessionId}.md`);
    const intentionHeading = fs.existsSync(intentionFile)
      ? await getIntentionHeading(intentionFile)
      : null;
    secureWriteFileSync(
      path.join(offloadDir, "meta.json"),
      JSON.stringify(
        {
          sessionId,
          claudeSessionId: sessionId,
          cwd: null,
          gitRoot: null,
          intentionHeading,
          lastInteractionTs: Math.floor(Date.now() / 1000),
          archivedAt: new Date().toISOString(),
          archived: true,
        },
        null,
        2,
      ),
    );
  }
  // Kill any orphaned extra terminals for this session immediately
  killOrphanedTerminals(sessionId);

  sessionsCache = null;
}

// Unarchive a session: remove the archived flag from its meta.
function unarchiveSession(sessionId) {
  validateSessionId(sessionId);
  const meta = readOffloadMeta(sessionId);
  if (!meta) return;
  delete meta.archived;
  delete meta.archivedAt;
  secureWriteFileSync(
    path.join(OFFLOADED_DIR, sessionId, "meta.json"),
    JSON.stringify(meta, null, 2),
  );
  sessionsCache = null;
}

// Remove offload data for a session (after resume)
function removeOffloadData(sessionId) {
  validateSessionId(sessionId);
  const offloadDir = path.join(OFFLOADED_DIR, sessionId);
  try {
    fs.rmSync(offloadDir, { recursive: true });
  } catch (err) {
    debugLog("main", "removeOffloadData failed for", sessionId, err.message);
  }
}

// Read offload snapshot (renders legacy raw PTY snapshots on the fly)
async function readOffloadSnapshot(sessionId) {
  validateSessionId(sessionId);
  const snapshotFile = path.join(OFFLOADED_DIR, sessionId, "snapshot.log");
  let text;
  try {
    text = fs.readFileSync(snapshotFile, "utf-8");
  } catch {
    /* ENOENT expected — snapshot may not exist */
    return null;
  }
  // Detect legacy raw PTY snapshots (contain ANSI escape sequences)
  if (text.includes("\x1b[")) {
    const rendered = await renderBufferToText(text);
    if (rendered != null) {
      // Overwrite with rendered version so future reads are fast
      try {
        secureWriteFileSync(snapshotFile, rendered);
      } catch {
        /* write-back is best-effort */
      }
      return rendered;
    }
  }
  return text;
}

// Read offload meta
function readOffloadMeta(sessionId) {
  validateSessionId(sessionId);
  const metaFile = path.join(OFFLOADED_DIR, sessionId, "meta.json");
  try {
    return JSON.parse(fs.readFileSync(metaFile, "utf-8"));
  } catch {
    /* ENOENT expected — meta may not exist, or JSON may be corrupted */
    return null;
  }
}

// --- Pool Management ---

function resolveClaudePath() {
  try {
    return execFileSync("which", ["claude"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    /* `which` fails if claude not in PATH — fall through to candidates */
  }
  const candidates = [
    path.join(os.homedir(), ".claude", "local", "bin", "claude"),
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".local", "bin", "claude"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Claude binary not found");
}

function readPool() {
  return readPoolFile(POOL_FILE);
}

function writePool(pool) {
  writePoolFile(POOL_FILE, pool);
  invalidateSessionsCache();
}

// Accept Claude's trust prompt by polling the terminal buffer until the prompt
// appears, then sending Enter. Reliable even when spawning many sessions at once.
async function acceptTrustPrompt(termId) {
  try {
    await poll(
      async () => {
        const buf = await readTerminalBuffer(termId);
        // Buffer contains ANSI cursor-movement codes between words, so match
        // a keyword that uniquely identifies the trust prompt.
        return buf.includes("trust?");
      },
      { interval: 500, timeout: 15000, label: "trust-prompt" },
    );
    // Small delay after prompt appears to ensure the TUI is ready for input
    await new Promise((r) => setTimeout(r, 200));
    daemonSendSafe({ type: "write", termId, data: "\r" });
  } catch {
    debugLog("main", `Trust prompt not detected for termId=${termId}`);
  }
}

// Async mutex for pool.json read-modify-write cycles.
// Serializes all concurrent access to prevent lost updates.
// NOT reentrant — calling withPoolLock from inside withPoolLock will deadlock.
let _poolLock = Promise.resolve();
let _poolLockHeld = false;
function withPoolLock(fn) {
  const p = _poolLock.then(() => {
    if (_poolLockHeld) {
      throw new Error(
        "withPoolLock called while lock is held — nested calls deadlock. " +
          "Restructure to avoid nesting (see withFreshSlot pattern).",
      );
    }
    _poolLockHeld = true;
    return Promise.resolve(fn()).finally(() => {
      _poolLockHeld = false;
    });
  });
  _poolLock = p.catch(() => {}); // keep chain alive on errors
  return p;
}

// Cached claude binary path — resolved once, reused for all spawns.
let _cachedClaudePath = null;
function getCachedClaudePath() {
  if (!_cachedClaudePath) _cachedClaudePath = resolveClaudePath();
  return _cachedClaudePath;
}

// Spawn a single Claude session via the PTY daemon. Returns a slot object.
async function spawnPoolSlot(index) {
  const claudePath = getCachedClaudePath();
  const resp = await daemonRequest({
    type: "spawn",
    cwd: os.homedir(),
    cmd: claudePath,
    args: ["--dangerously-skip-permissions"],
    env: { OPEN_COCKPIT_POOL: "1" },
  });
  return createSlot(index, resp.termId, resp.pid);
}

// Initialize pool: spawn N Claude sessions via PTY daemon.
// Returns immediately after spawning — slot tracking (session ID discovery)
// happens in the background. Slots start as "starting" and transition to
// "fresh" once Claude is ready. The UI handles this via pool health polling.
async function poolInit(size) {
  const pool = await withPoolLock(async () => {
    size = Math.max(1, Math.min(20, size || DEFAULT_POOL_SIZE));
    const existing = readPool();
    if (existing) {
      throw new Error(
        `Pool already initialized (${existing.slots.length} slots)`,
      );
    }

    const p = {
      version: 1,
      poolSize: size,
      createdAt: new Date().toISOString(),
      slots: [],
    };

    // Spawn each slot as a Claude session in a daemon terminal (parallel)
    p.slots = await Promise.all(
      Array.from({ length: size }, (_, i) => spawnPoolSlot(i)),
    );

    writePool(p);
    return p;
  });

  // Track all slots in background (fire-and-forget, like poolResize).
  for (const slot of pool.slots) {
    trackNewSlot(slot);
  }

  return readPool();
}

// Poll for a session-pid file to appear (or change from excludeId) for a PID.
// Used both for initial session discovery and after /clear (which reuses the PID).
async function pollForSessionId(pid, timeoutMs, excludeId = null) {
  if (excludeId) await new Promise((r) => setTimeout(r, 2000)); // Give /clear time
  try {
    return await poll(
      () => {
        try {
          const sessionId = fs
            .readFileSync(path.join(SESSION_PIDS_DIR, String(pid)), "utf-8")
            .trim();
          if (sessionId && sessionId !== excludeId) return sessionId;
        } catch {} // File doesn't exist yet
        return null;
      },
      { interval: 200, timeout: timeoutMs, label: `session ID for PID ${pid}` },
    );
  } catch {
    return null; // Timeout → null (preserves original behavior)
  }
}

// After spawning, track the slot until it gets a session ID.
// Runs trust prompt acceptance + session ID polling in background.
// Updates pool.json via withPoolLock when done.
// Returns a promise that resolves to the session ID (can be awaited or fire-and-forget).
function trackNewSlot(
  slot,
  {
    timeout = 60000,
    excludeId = null,
    expectedStatus = POOL_STATUS.STARTING,
    skipTrustPrompt = false,
    skipFreshSignal = false,
    onResolved = null,
  } = {},
) {
  if (!skipTrustPrompt) acceptTrustPrompt(slot.termId);
  return pollForSessionId(slot.pid, timeout, excludeId)
    .then(async (sessionId) => {
      await withPoolLock(() => {
        const p = readPool();
        if (!p) return;
        const s = p.slots.find((x) => x.termId === slot.termId);
        if (s && s.status === expectedStatus) {
          s.sessionId = sessionId;
          if (skipFreshSignal) {
            // Resume case: keep slot as busy, let real idle hook handle status
            if (!sessionId) {
              s.status = POOL_STATUS.ERROR;
              debugLog(
                "main",
                `Slot resume failed: termId=${slot.termId} pid=${slot.pid} — no session ID`,
              );
            }
          } else {
            s.status = sessionId ? POOL_STATUS.FRESH : POOL_STATUS.ERROR;
            if (sessionId) {
              createFreshIdleSignal(s.pid, sessionId);
            } else {
              debugLog(
                "main",
                `Slot init failed: termId=${slot.termId} pid=${slot.pid} — no session ID`,
              );
            }
          }
          writePool(p);
        }
      });
      if (onResolved) await onResolved(sessionId);
      return sessionId;
    })
    .catch(async (err) => {
      debugLog(
        "main",
        `Slot tracking failed: termId=${slot.termId} pid=${slot.pid} err=${err.message}`,
      );
      await withPoolLock(() => {
        const p = readPool();
        if (!p) return;
        const s = p.slots.find((x) => x.termId === slot.termId);
        if (s && s.status === expectedStatus) {
          s.status = POOL_STATUS.ERROR;
          writePool(p);
        }
      });
    });
}

// Resize pool: add or remove slots
async function poolResize(newSize) {
  return withPoolLock(async () => {
    newSize = Math.max(1, Math.min(20, newSize));
    const pool = readPool();
    if (!pool) throw new Error("Pool not initialized");

    const currentSize = pool.slots.length;
    if (newSize === currentSize) return pool;

    if (newSize > currentSize) {
      // Grow: spawn new slots in parallel
      const newSlots = await Promise.all(
        Array.from({ length: newSize - currentSize }, (_, j) =>
          spawnPoolSlot(currentSize + j),
        ),
      );
      pool.slots.push(...newSlots);

      // Track new slots in background (trust prompt + session ID polling)
      for (const slot of newSlots) {
        trackNewSlot(slot);
      }
    } else {
      // Shrink: kill excess slots (prefer fresh, then LRU idle)
      const toRemove = currentSize - newSize;
      const candidates = selectShrinkCandidates(pool.slots, toRemove);

      let removed = 0;
      for (const slot of candidates) {
        await killSlotProcess(slot);
        pool.slots = pool.slots.filter((s) => s.index !== slot.index);
        removed++;
      }

      // Re-index remaining slots
      pool.slots.forEach((s, i) => (s.index = i));
    }

    pool.poolSize = newSize;
    writePool(pool);
    return pool;
  });
}

// Get pool health: enrich pool.json slots with live session data
async function getPoolHealth() {
  const pool = readPool();
  const sessions = await getSessions();
  return computePoolHealth(pool, sessions, (pid) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      /* ESRCH expected — process existence check */
      return false;
    }
  });
}

// Clean up idle signal files for PIDs that no longer exist.
// Prevents unbounded growth and false idle detection from PID reuse.
function cleanupStaleIdleSignals() {
  if (!fs.existsSync(IDLE_SIGNALS_DIR)) return;
  const sessionPids = new Set(
    fs.existsSync(SESSION_PIDS_DIR) ? fs.readdirSync(SESSION_PIDS_DIR) : [],
  );
  for (const filename of fs.readdirSync(IDLE_SIGNALS_DIR)) {
    const pid = Number(filename);
    if (isNaN(pid)) continue;
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // process doesn't exist
    }
    if (!alive || !sessionPids.has(filename)) {
      try {
        fs.unlinkSync(path.join(IDLE_SIGNALS_DIR, filename));
        console.log(
          `[main] Removed stale idle signal for PID ${pid}` +
            (!alive ? " (dead)" : " (no session-pids entry)"),
        );
      } catch {
        // ignore removal errors
      }
    }
  }
}

// Reconcile pool.json with reality on startup.
// Daemon terminals survive app restarts, so pool slots should still be alive.
// Update any stale state (dead terminals, changed PIDs, etc.)
async function reconcilePool() {
  return withPoolLock(async () => {
    const pool = readPool();
    if (!pool) return;

    let changed = false;
    const recovered = [];
    let daemonPtys;
    try {
      const resp = await daemonRequest({ type: "list" });
      daemonPtys = new Map(resp.ptys.map((p) => [p.termId, p]));
    } catch {
      return; // Daemon not running — can't reconcile
    }

    for (const slot of pool.slots) {
      const pty = daemonPtys.get(slot.termId);
      const needsRestart =
        !pty || pty.exited || slot.status === POOL_STATUS.ERROR;

      if (needsRestart) {
        const reason =
          !pty || pty.exited ? POOL_STATUS.DEAD : POOL_STATUS.ERROR;
        if (!pty || pty.exited) {
          if (slot.status !== POOL_STATUS.DEAD) {
            slot.status = POOL_STATUS.DEAD;
            changed = true;
          }
        }
        // Clean up terminal input cache for old termId
        terminalHasInputCache.delete(slot.termId);
        // Kill old process/PTY before restarting
        await killSlotProcess(slot);
        // Auto-restart slot
        try {
          debugLog(
            "main",
            `Auto-recovering ${reason} slot ${slot.index} (termId=${slot.termId} pid=${slot.pid})`,
          );
          const newSlot = await spawnPoolSlot(slot.index);
          slot.termId = newSlot.termId;
          slot.pid = newSlot.pid;
          slot.status = POOL_STATUS.STARTING;
          slot.sessionId = null;
          changed = true;
          recovered.push({ index: slot.index, reason });
          trackNewSlot(slot);
        } catch (err) {
          debugLog(
            "main",
            `Failed to restart slot ${slot.index}: ${err.message}`,
          );
        }
        continue;
      }

      // Terminal alive — update PID if it changed (shouldn't, but safety)
      if (pty.pid !== slot.pid) {
        slot.pid = pty.pid;
        changed = true;
      }

      // Re-check session ID mapping
      const pidFile = path.join(SESSION_PIDS_DIR, String(slot.pid));
      if (fs.existsSync(pidFile)) {
        const sessionId = fs.readFileSync(pidFile, "utf-8").trim();
        if (sessionId && sessionId !== slot.sessionId) {
          if (slot.sessionId) {
            await saveExternalClearOffload(slot.sessionId, slot.pid);
          }
          slot.sessionId = sessionId;
          slot.status = POOL_STATUS.FRESH;
          changed = true;
        }
      }
    }

    if (changed) writePool(pool);

    // Notify renderer about recovered slots
    if (recovered.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pool-slots-recovered", recovered);
    }

    // Prune session graph — remove entries for sessions that no longer exist
    pruneSessionGraph(pool);
  });
}

function getPoolTermIds() {
  const pool = readPool();
  const ids = new Set();
  if (pool) {
    for (const slot of pool.slots) ids.add(slot.termId);
  }
  return ids;
}

// Kill all orphaned extra terminals for a specific session.
function killOrphanedTerminals(sessionId) {
  const poolTermIds = getPoolTermIds();
  daemonRequest({ type: "list" })
    .then((resp) => {
      for (const pty of resp.ptys) {
        if (pty.sessionId === sessionId && !poolTermIds.has(pty.termId)) {
          daemonRequest({ type: "kill", termId: pty.termId }).catch((err) =>
            debugLog(
              "main",
              `Failed to kill orphaned terminal ${pty.termId}: ${err.message}`,
            ),
          );
        }
      }
    })
    .catch((err) => {
      debugLog("main", `killOrphanedTerminals failed: ${err.message}`);
    });
}

// Kill orphaned extra terminals for sessions offloaded > TTL or archived.
// Runs after reconcilePool on the same 30s interval.
async function reapOrphanedTerminals() {
  let ptys;
  try {
    const resp = await daemonRequest({ type: "list" });
    ptys = resp.ptys;
  } catch {
    return; // Daemon not running
  }

  const poolTermIds = getPoolTermIds();

  // Batch-read offload metadata by unique sessionId (avoid N+1 reads)
  const candidatePtys = ptys.filter(
    (p) => p.sessionId && !p.exited && !poolTermIds.has(p.termId),
  );
  const sessionIds = [...new Set(candidatePtys.map((p) => p.sessionId))];
  const metaBySession = new Map();
  for (const sid of sessionIds) {
    const meta = readOffloadMeta(sid);
    if (meta) metaBySession.set(sid, meta);
  }

  const now = Date.now();
  for (const pty of candidatePtys) {
    const meta = metaBySession.get(pty.sessionId);
    if (!meta) continue; // Session still live — not our concern

    const shouldKill =
      meta.archived ||
      (meta.offloadedAt &&
        now - new Date(meta.offloadedAt).getTime() > ORPHAN_TERMINAL_TTL_MS);

    if (shouldKill) {
      debugLog(
        "main",
        `Reaping orphaned terminal ${pty.termId} for ${meta.archived ? "archived" : "stale offloaded"} session ${pty.sessionId}`,
      );
      try {
        await daemonRequest({ type: "kill", termId: pty.termId });
      } catch (err) {
        debugLog(
          "main",
          `Failed to reap terminal ${pty.termId}: ${err.message}`,
        );
      }
    }
  }
}

function pruneSessionGraph(pool) {
  const graph = readSessionGraph();
  const graphKeys = Object.keys(graph);
  if (graphKeys.length === 0) return;

  // Collect all known session IDs: pool slots + live sessions + offloaded/archived
  const knownIds = new Set();
  for (const slot of pool.slots) {
    if (slot.sessionId) knownIds.add(slot.sessionId);
  }
  // Include live non-pool sessions (ext, sub-claude) from session-pids
  try {
    for (const file of fs.readdirSync(SESSION_PIDS_DIR)) {
      try {
        const sessionId = fs
          .readFileSync(path.join(SESSION_PIDS_DIR, file), "utf-8")
          .trim();
        if (sessionId) knownIds.add(sessionId);
      } catch {
        /* ENOENT race — file removed between readdir and read */
      }
    }
  } catch {
    /* SESSION_PIDS_DIR may not exist */
  }
  try {
    for (const dir of fs.readdirSync(OFFLOADED_DIR)) {
      knownIds.add(dir);
    }
  } catch {
    /* OFFLOADED_DIR may not exist */
  }

  let pruned = false;
  for (const id of graphKeys) {
    if (!knownIds.has(id)) {
      delete graph[id];
      pruned = true;
    }
  }
  if (pruned) writeSessionGraph(graph);
}

// Sync pool.json slot statuses with live session state.
async function syncPoolStatuses(sessions) {
  await withPoolLock(() => {
    const pool = readPool();
    if (!pool) return;
    const updated = syncStatuses(pool, sessions);
    if (updated) writePool(updated);
  });
}

// Kill a pool slot's process: try daemon first, then fall back to PID kill.
// This prevents orphans when the daemon was restarted and termIds are stale.
async function killSlotProcess(slot) {
  try {
    await daemonRequest({ type: "kill", termId: slot.termId });
  } catch (err) {
    // Daemon kill failed (stale termId or daemon down) — kill by PID directly
    console.error(
      "[main] Daemon kill failed for slot",
      slot.index,
      "termId",
      slot.termId,
      err.message,
    );
    if (slot.pid) {
      try {
        process.kill(slot.pid, "SIGTERM");
      } catch {
        /* ESRCH expected — process may already be dead */
      }
    }
  }
}

// Destroy pool: kill all slots and remove pool.json
async function poolDestroy() {
  return withPoolLock(async () => {
    const pool = readPool();
    if (!pool) return;
    for (const slot of pool.slots) {
      await killSlotProcess(slot);
      // Clean up idle-signal and session-pid files so destroyed slots
      // don't appear as ghost "ext fresh" sessions after pool removal.
      for (const dir of [IDLE_SIGNALS_DIR, SESSION_PIDS_DIR]) {
        try {
          fs.unlinkSync(path.join(dir, String(slot.pid)));
        } catch {}
      }
    }
    terminalHasInputCache.clear();
    try {
      fs.unlinkSync(POOL_FILE);
    } catch (err) {
      debugLog("main", "poolDestroy: failed to unlink pool.json:", err.message);
    }
    // Archive non-archived offloaded sessions so they don't linger in Recent
    for (const s of await getOffloadedSessions()) {
      if (s.status === STATUS.OFFLOADED) await archiveSession(s.sessionId);
    }
  });
}

// Validate termId: must be a finite number
function validateTermId(termId) {
  if (typeof termId !== "number" || !Number.isFinite(termId)) {
    throw new Error("Invalid termId: must be a number");
  }
}

function readIntention(sessionId) {
  const file = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}

// Track the last content we wrote per session so we can detect external changes
const lastWrittenContent = new Map();

function writeIntention(sessionId, content) {
  secureMkdirSync(INTENTIONS_DIR, { recursive: true });
  lastWrittenContent.set(sessionId, content);
  secureWriteFileSync(path.join(INTENTIONS_DIR, `${sessionId}.md`), content);
}

async function poolClean() {
  const pool = readPool();
  if (!pool) throw new Error("Pool not initialized");
  const sessions = await getSessions();
  const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));
  const idleSlots = pool.slots.filter((s) => {
    const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
    return session && session.status === STATUS.IDLE;
  });
  let cleaned = 0;
  for (const slot of idleSlots) {
    // Re-check status before offloading (slot may have become busy since we read)
    const currentSessions = await getSessions();
    const currentSession = currentSessions.find(
      (s) => s.sessionId === slot.sessionId,
    );
    if (!currentSession || currentSession.status !== STATUS.IDLE) {
      continue;
    }
    await offloadSession(slot.sessionId, slot.termId, null, {
      cwd: currentSession.cwd,
      gitRoot: currentSession.gitRoot,
      pid: slot.pid,
    });
    await archiveSession(slot.sessionId);
    cleaned++;
  }
  return cleaned;
}

// Ensure a fresh pool slot exists, offloading the LRU idle session if needed.
// Find offload target from pool/sessions without acquiring lock.
// Returns offload info or null if a fresh slot already exists.
function findOffloadTarget(pool, sessionMap) {
  // Only truly fresh slots count — typing sessions (user has started composing) are not available
  const hasFresh = pool.slots.some((s) => {
    if (s.status === POOL_STATUS.FRESH) return true;
    const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
    return session && session.status === STATUS.FRESH;
  });
  if (hasFresh) return null;

  const idleSlots = pool.slots.filter((s) => {
    if (isSlotPinned(s)) return false;
    const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
    return session && session.status === STATUS.IDLE;
  });
  if (idleSlots.length === 0)
    throw new Error("No fresh or idle slots available");
  idleSlots.sort((a, b) => {
    const sa = sessionMap.get(a.sessionId);
    const sb = sessionMap.get(b.sessionId);
    return (sa?.idleTs || 0) - (sb?.idleTs || 0);
  });
  const victim = idleSlots[0];
  const vs = sessionMap.get(victim.sessionId);
  return {
    sessionId: victim.sessionId,
    termId: victim.termId,
    pid: victim.pid,
    cwd: vs?.cwd,
    gitRoot: vs?.gitRoot,
  };
}

// Ensure a fresh slot exists, then atomically claim and return it.
// The claimFn receives (pool, slot) inside the lock and should perform
// the slot-specific work (send prompt / resume command, mark busy, etc.).
// Returns whatever claimFn returns.
async function withFreshSlot(claimFn) {
  // Phase 1: check if offload is needed (inside lock)
  const needsOffload = await withPoolLock(async () => {
    const pool = readPool();
    if (!pool) throw new Error("Pool not initialized");
    const sessions = await getSessions();
    const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));
    return findOffloadTarget(pool, sessionMap);
  });

  // Phase 2: offload outside lock (offloadSession acquires its own lock)
  if (needsOffload) {
    await offloadSession(needsOffload.sessionId, needsOffload.termId, null, {
      cwd: needsOffload.cwd,
      gitRoot: needsOffload.gitRoot,
      pid: needsOffload.pid,
    });
    await pollForSessionId(needsOffload.pid, 30000, needsOffload.sessionId);
  }

  // Phase 3: claim fresh slot atomically (inside lock — no gap for races)
  return withPoolLock(async () => {
    const pool = readPool();
    if (!pool) throw new Error("Pool not initialized");
    const sessions = await getSessions();
    const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));

    const slot = pool.slots.find((s) => {
      if (s.status === POOL_STATUS.FRESH) return true;
      const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
      return session && session.status === STATUS.FRESH;
    });
    if (!slot) throw new Error("No fresh slots available");

    return claimFn(pool, slot);
  });
}

async function poolResume(sessionId) {
  validateSessionId(sessionId);
  const meta = readOffloadMeta(sessionId);
  if (!meta) throw new Error("No offload data for session");
  const claudeSessionId = meta.claudeSessionId || meta.sessionId;
  if (!claudeSessionId) throw new Error("No Claude session ID stored");

  if (meta.archived) {
    unarchiveSession(sessionId);
  }

  // Atomically ensure a fresh slot and claim it for /resume
  return withFreshSlot(async (pool, slot) => {
    const oldSlotSessionId = slot.sessionId;

    try {
      await sendCommandToTerminal(slot.termId, `/resume ${claudeSessionId}`);
    } catch (err) {
      console.error("[main] /resume command failed:", err.message);
      throw err; // slot stays fresh (withFreshSlot default)
    }
    slot.status = POOL_STATUS.BUSY;
    writePool(pool);

    // Track slot in background (session ID polling after /resume)
    trackNewSlot(
      { termId: slot.termId, pid: slot.pid },
      {
        excludeId: oldSlotSessionId,
        expectedStatus: POOL_STATUS.BUSY,
        skipTrustPrompt: true,
        skipFreshSignal: true,
        onResolved: async (newSessionId) => {
          // Re-tag orphaned extra terminals from old session to new session
          if (newSessionId) {
            try {
              const resp = await daemonRequest({ type: "list" });
              const orphaned = resp.ptys.filter(
                (p) => p.sessionId === sessionId && !p.exited,
              );
              await Promise.all(
                orphaned.map((pty) =>
                  daemonRequest({
                    type: "set-session",
                    termId: pty.termId,
                    sessionId: newSessionId,
                  }),
                ),
              );
            } catch (err) {
              debugLog(
                "main",
                `Failed to re-tag orphaned terminals: ${err.message}`,
              );
            }
            removeOffloadData(sessionId);
          }
          invalidateSessionsCache();
        },
      },
    );

    return {
      type: "resumed",
      sessionId,
      termId: slot.termId,
      slotIndex: slot.index,
    };
  });
}

function watchIntention(sessionId) {
  // Clean up previous watcher
  if (fileWatchers.has("current")) {
    fs.unwatchFile(fileWatchers.get("current"));
    fileWatchers.delete("current");
  }
  // Reset change-detection state so we don't suppress notifications for new session
  lastWrittenContent.delete(sessionId);

  const file = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  secureMkdirSync(INTENTIONS_DIR, { recursive: true });

  // Use polling (fs.watchFile) — reliable on macOS unlike fs.watch.
  // Works on non-existent files too (detects when file appears).
  fs.watchFile(file, { interval: 500 }, () => {
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return; // File not yet created
      console.error(
        "[main] Failed to read intention file on change",
        file,
        err.message,
      );
      return;
    }
    // Skip if this is content we wrote ourselves
    if (content === lastWrittenContent.get(sessionId)) return;
    lastWrittenContent.set(sessionId, content);
    console.log("[main] External file change detected, sending to renderer");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("intention-changed", content);
    }
  });

  fileWatchers.set("current", file);
}

const pendingPolls = new Set();

// Open the session's project directory in Cursor.
// Checks for .code-workspace files (matching project name or inside folder).
async function openInCursor(cwd) {
  if (!cwd) return;

  const projectName = path.basename(cwd);
  const workspaceDir = path.join(
    os.homedir(),
    "Documents",
    "Projects",
    "VS code workspaces",
  );

  // Check named workspace file
  const namedWorkspace = path.join(
    workspaceDir,
    `${projectName}.code-workspace`,
  );
  if (fs.existsSync(namedWorkspace)) {
    await execFileAsync("open", ["-a", "Cursor", namedWorkspace]);
    return;
  }

  // Check in-folder workspace file
  try {
    const entries = fs.readdirSync(cwd);
    const localWs = entries.find((e) => e.endsWith(".code-workspace"));
    if (localWs) {
      await execFileAsync("open", ["-a", "Cursor", path.join(cwd, localWs)]);
      return;
    }
  } catch {
    /* ignore read errors */
  }

  // Fall back to opening the folder
  await execFileAsync("open", ["-a", "Cursor", cwd]);
}

// Try to focus the external terminal (iTerm or Cursor) where a Claude session is running.
// Returns { focused: true, app: "iTerm"/"Cursor" } or { focused: false }.
function focusExternalTerminal(pid) {
  if (!/^\d+$/.test(String(pid))) return { focused: false };

  const { execFileSync } = require("child_process");

  // Get the TTY of the Claude process
  let tty;
  try {
    tty = execFileSync("ps", ["-p", String(pid), "-o", "tty="], {
      encoding: "utf-8",
    }).trim();
  } catch {
    /* process may have exited — can't determine TTY */
    return { focused: false };
  }
  if (!tty || tty === "??" || !/^ttys?\d+$/.test(tty))
    return { focused: false };

  const EXEC_TIMEOUT = 3000;

  // Try iTerm: find the session with this TTY and focus it
  try {
    const result = execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
  if not (exists process "iTerm2") then return "not_running"
end tell
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s ends with "${tty}" then
          select t
          set index of w to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`,
      ],
      { encoding: "utf-8", timeout: EXEC_TIMEOUT },
    ).trim();
    if (result === "focused") return { focused: true, app: "iTerm" };
  } catch (err) {
    console.error(
      "[main] iTerm focus check via osascript failed:",
      err.message,
    );
  }

  // Try Cursor / VS Code: walk process tree to find terminal app ancestor
  const TERMINAL_APPS = [
    { match: /\/Cursor(\.app\/|\s|$)/, app: "Cursor", activate: "Cursor" },
    {
      match: /\/Code(\.app\/|\s|$)/,
      app: "VS Code",
      activate: "Visual Studio Code",
    },
  ];
  try {
    let checkPid = String(pid);
    for (let i = 0; i < 10; i++) {
      const ppid = execFileSync("ps", ["-p", checkPid, "-o", "ppid="], {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT,
      }).trim();
      if (!ppid || ppid === "0" || ppid === "1") break;
      const pname = execFileSync("ps", ["-p", ppid, "-o", "comm="], {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT,
      }).trim();
      for (const { match, app, activate } of TERMINAL_APPS) {
        if (match.test(pname)) {
          execFileSync("osascript", [
            "-e",
            `tell application "${activate}" to activate`,
          ]);
          return { focused: true, app };
        }
      }
      checkPid = ppid;
    }
  } catch (err) {
    console.error(
      "[main] Terminal focus process tree walk failed for PID",
      pid,
      err.message,
    );
  }

  return { focused: false };
}

// --- Daemon client helpers ---

function isDaemonRunning() {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    /* ENOENT/ESRCH expected — PID file missing or daemon dead */
    return false;
  }
}

function getDaemonExecPath() {
  // On macOS, process.execPath points into an .app bundle
  // (e.g. Electron.app/Contents/MacOS/Electron). Spawning a detached child
  // from that path causes macOS to show a second Dock / Cmd+Tab entry.
  // Work around this by creating a symlink outside the .app bundle — same
  // binary, same Node ABI, but macOS no longer associates it with the app.
  if (process.platform !== "darwin") return process.execPath;

  const link = path.join(OPEN_COCKPIT_DIR, "electron-node");
  try {
    const target = fs.readlinkSync(link);
    if (target === process.execPath) return link;
    fs.unlinkSync(link);
  } catch (e) {
    if (e.code !== "ENOENT")
      debugLog("electron-node symlink issue:", e.message);
  }
  fs.symlinkSync(process.execPath, link);
  return link;
}

function startDaemon() {
  return new Promise((resolve, reject) => {
    if (isDaemonRunning()) return resolve();

    const child = spawnChild(getDaemonExecPath(), [DAEMON_SCRIPT], {
      detached: true,
      stdio: "ignore",
      cwd: os.homedir(), // Don't inherit app cwd — prevents kill-by-cwd from hitting daemon
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
  if (!daemonSocket || daemonSocket.destroyed) {
    throw new Error("Daemon socket is not connected");
  }
  daemonSocket.write(JSON.stringify(msg) + "\n");
}

// Safe wrapper for fire-and-forget daemonSend calls that should not crash
// the app if the daemon socket is disconnected.
async function daemonSendSafe(msg) {
  try {
    return await daemonSend(msg);
  } catch (err) {
    console.error(
      "daemonSend failed (daemon may be disconnected):",
      err.message,
    );
    return null;
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
  debugLog("main", `starting${IS_DEV ? " (dev)" : ""} pid=${process.pid}`);
  // Ensure setup-scripts directory exists
  secureMkdirSync(SETUP_SCRIPTS_DIR, { recursive: true });

  // Start daemon connection early
  try {
    await ensureDaemon();
  } catch (err) {
    console.error("[main] Failed to start daemon:", err.message);
  }

  // Clean up stale idle signal files before reconciling pool
  try {
    cleanupStaleIdleSignals();
  } catch (err) {
    console.error("[main] Idle signal cleanup failed:", err.message);
  }

  // Reconcile pool state with surviving daemon terminals (startup + periodic)
  try {
    await reconcilePool();
  } catch (err) {
    console.error("[main] Pool reconciliation failed:", err.message);
  }
  setInterval(async () => {
    try {
      await reconcilePool();
    } catch {
      /* logged inside reconcilePool */
    }
    try {
      await reapOrphanedTerminals();
    } catch {
      /* logged inside reapOrphanedTerminals */
    }
  }, 30000);

  // Watch session-pids and idle-signals dirs for changes → push updates to renderer.
  // Debounced: fs.watch fires multiple events per operation.
  let watchDebounce = null;
  function onDirChange() {
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      watchDebounce = null;
      invalidateSessionsCache();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("sessions-changed");
      }
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
  // process.kill(pid, 0) is a single syscall per PID — no subprocess overhead.
  // Note: PID reuse could cause a false "alive" — extremely unlikely on macOS and harmless
  // (the stale PID file gets cleaned up on the next full refresh anyway).
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
  setInterval(() => pollTerminalInput().catch(() => {}), TERMINAL_POLL_MS);

  ipcMain.on("debug-log", (_e, tag, args) => {
    debugLog(tag, ...args);
  });
  ipcMain.handle("get-dir-colors", () => {
    try {
      return JSON.parse(fs.readFileSync(COLORS_FILE, "utf-8"));
    } catch {
      /* ENOENT expected — colors.json is optional */
      return {};
    }
  });
  ipcMain.handle("get-sessions", async () => {
    const sessions = await getSessions();
    await syncPoolStatuses(sessions);
    // Enrich with pinned status and session graph
    const pool = readPool();
    if (pool) {
      const slotMap = new Map(
        pool.slots.filter((s) => s.sessionId).map((s) => [s.sessionId, s]),
      );
      for (const s of sessions) {
        const slot = slotMap.get(s.sessionId);
        if (slot?.pinnedUntil) s.pinnedUntil = slot.pinnedUntil;
      }
    }
    enrichSessionsWithGraphData(sessions);
    return sessions;
  });
  ipcMain.handle("read-intention", (_e, sessionId) => {
    validateSessionId(sessionId);
    return readIntention(sessionId);
  });
  ipcMain.handle("write-intention", (_e, sessionId, content) => {
    validateSessionId(sessionId);
    return writeIntention(sessionId, content);
  });
  ipcMain.handle("watch-intention", (_e, sessionId) => {
    validateSessionId(sessionId);
    return watchIntention(sessionId);
  });

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
    daemonSendSafe({ type: "write", termId, data });
    triggerPollOnWrite(termId);
  });

  ipcMain.handle("pty-resize", async (_e, termId, cols, rows) => {
    await ensureDaemon();
    daemonSendSafe({ type: "resize", termId, cols, rows });
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
    daemonSendSafe({ type: "detach", termId });
  });

  ipcMain.handle("pty-set-session", async (_e, termId, sessionId) => {
    await daemonRequest({ type: "set-session", termId, sessionId });
  });

  ipcMain.handle("focus-external-terminal", (_e, pid) =>
    focusExternalTerminal(pid),
  );

  ipcMain.handle("open-in-cursor", (_e, cwd) => openInCursor(cwd));

  // Pool / offload IPC handlers
  ipcMain.handle(
    "offload-session",
    async (_e, sessionId, termId, claudeSessionId, sessionInfo) =>
      offloadSession(sessionId, termId, claudeSessionId, sessionInfo),
  );
  ipcMain.handle("remove-offload-data", (_e, sessionId) =>
    removeOffloadData(sessionId),
  );
  ipcMain.handle("read-offload-snapshot", (_e, sessionId) =>
    readOffloadSnapshot(sessionId),
  );
  ipcMain.handle("read-offload-meta", (_e, sessionId) =>
    readOffloadMeta(sessionId),
  );
  ipcMain.handle("archive-session", (_e, sessionId) =>
    archiveSession(sessionId),
  );
  ipcMain.handle("unarchive-session", (_e, sessionId) =>
    unarchiveSession(sessionId),
  );

  // Pool management
  ipcMain.handle("pool-init", async (_e, size) => poolInit(size));
  ipcMain.handle("pool-resize", async (_e, newSize) => poolResize(newSize));
  ipcMain.handle("pool-health", () => getPoolHealth()); // getPoolHealth is async, returns promise — ipcMain.handle awaits it
  ipcMain.handle("pool-read", () => readPool());
  ipcMain.handle("pool-destroy", async () => poolDestroy());
  ipcMain.handle("pool-clean", () => poolClean());
  ipcMain.handle("pool-resume", async (_e, sessionId) => poolResume(sessionId));

  // Setup scripts
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

  // --- Pool interaction helpers (used by API commands) ---

  function findSlotBySessionId(sessionId) {
    return findSlotBySessionIdInPool(readPool(), sessionId);
  }

  function findSlotByIndex(slotIndex) {
    return findSlotByIndexInPool(readPool(), slotIndex);
  }

  function resolveSlot(msg) {
    return resolveSlotInPool(readPool(), msg);
  }

  async function getTerminalBuffer(termId) {
    const resp = await daemonRequest({ type: "list" });
    const pty = resp.ptys.find((p) => p.termId === termId);
    return pty ? pty.buffer || "" : "";
  }

  async function getSessionTerminals(sessionId) {
    validateSessionId(sessionId);
    const resp = await daemonRequest({ type: "list" });
    const pool = readPool();
    const slot = pool?.slots.find((s) => s.sessionId === sessionId);
    const tuiTermId = slot?.termId ?? null;

    const terms = resp.ptys
      .filter((p) => p.sessionId === sessionId && !p.exited)
      .sort((a, b) => a.termId - b.termId);

    let shellCount = 0;
    return terms.map((p, i) => {
      const isTui = p.termId === tuiTermId;
      if (!isTui) shellCount++;
      return {
        termId: p.termId,
        index: i,
        label: isTui ? "Claude" : `Shell ${shellCount}`,
        isTui,
        pid: p.pid,
        cwd: p.cwd,
        buffer: p.buffer || "",
      };
    });
  }

  async function sendPromptToTerminal(termId, prompt) {
    await sendCommandToTerminal(termId, prompt);
  }

  async function getEffectiveSlotStatus(slot) {
    const sessions = await getSessions();
    const session = sessions.find((s) => s.sessionId === slot.sessionId);
    if (!session) return slot.status;
    if (session.status === STATUS.IDLE) return POOL_STATUS.IDLE;
    if (session.status === STATUS.PROCESSING) return POOL_STATUS.BUSY;
    if (session.status === STATUS.FRESH) return POOL_STATUS.FRESH;
    if (session.status === STATUS.TYPING) return STATUS.TYPING;
    return slot.status;
  }

  function waitForSessionIdle(sessionId, timeoutMs = 300000) {
    return poll(
      async () => {
        const sessions = await getSessions();
        const session = sessions.find((s) => s.sessionId === sessionId);
        if (session && session.status === STATUS.IDLE) return true;
        if (session && !session.alive) throw new Error("Session process died");
        return null;
      },
      {
        interval: 1000,
        initialDelay: 1000,
        timeout: timeoutMs,
        label: "waiting for session to become idle",
      },
    );
  }

  // --- Programmatic API server (Unix socket) ---
  const apiServer = createApiServer(API_SOCKET, {
    ping: async () => ({ type: "pong" }),
    "get-sessions": async () => {
      const sessions = await getSessions();
      enrichSessionsWithGraphData(sessions);
      return { type: "sessions", sessions };
    },
    "pool-init": async (msg) => ({
      type: "pool",
      pool: await poolInit(msg.size),
    }),
    "pool-resize": async (msg) => ({
      type: "pool",
      pool: await poolResize(msg.size),
    }),
    "pool-health": async () => ({
      type: "health",
      health: await getPoolHealth(),
    }),
    "pool-read": async () => ({
      type: "pool",
      pool: readPool(),
    }),
    "pool-destroy": async () => {
      await poolDestroy();
      return { type: "ok" };
    },
    "read-intention": async (msg) => {
      validateSessionId(msg.sessionId);
      return { type: "intention", content: readIntention(msg.sessionId) };
    },
    "write-intention": async (msg) => {
      validateSessionId(msg.sessionId);
      writeIntention(msg.sessionId, msg.content);
      return { type: "ok" };
    },
    "pty-list": async () => {
      const resp = await daemonRequest({ type: "list" });
      return { type: "ptys", ptys: resp.ptys };
    },
    "pty-write": async (msg) => {
      validateTermId(msg.termId);
      daemonSendSafe({ type: "write", termId: msg.termId, data: msg.data });
      triggerPollOnWrite(msg.termId);
      return { type: "ok" };
    },
    "pty-spawn": async (msg) => {
      const resp = await daemonRequest({
        type: "spawn",
        cwd: msg.cwd,
        cmd: msg.cmd,
        args: msg.args,
        sessionId: msg.sessionId,
      });
      return { type: "spawned", termId: resp.termId, pid: resp.pid };
    },
    "pty-kill": async (msg) => {
      validateTermId(msg.termId);
      await daemonRequest({ type: "kill", termId: msg.termId });
      return { type: "ok" };
    },
    "pty-read": async (msg) => {
      validateTermId(msg.termId);
      const resp = await daemonRequest({ type: "list" });
      const p = resp.ptys.find((p) => p.termId === msg.termId);
      return { type: "buffer", buffer: p ? p.buffer : null };
    },

    // --- Pool interaction commands (sub-claude compatible) ---

    "pool-start": async (msg) => {
      if (!msg.prompt) throw new Error("prompt required");
      const result = await withFreshSlot(async (pool, slot) => {
        await sendPromptToTerminal(slot.termId, msg.prompt);
        slot.status = POOL_STATUS.BUSY;
        writePool(pool);

        return {
          type: "started",
          sessionId: slot.sessionId,
          termId: slot.termId,
          slotIndex: slot.index,
        };
      });
      recordSessionRelation(
        result.sessionId,
        msg.parentSessionId || null,
        msg.parentSessionId ? "model" : "user",
      );
      return result;
    },

    "pool-resume": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      return poolResume(msg.sessionId);
    },

    "pool-followup": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      if (!msg.prompt) throw new Error("prompt required");
      return withPoolLock(async () => {
        const { pool, slot } = findSlotBySessionId(msg.sessionId);

        const status = await getEffectiveSlotStatus(slot);
        if (status !== POOL_STATUS.IDLE)
          throw new Error(`Session is ${status}, expected idle`);

        await sendPromptToTerminal(slot.termId, msg.prompt);
        slot.status = POOL_STATUS.BUSY;
        writePool(pool);

        return {
          type: "started",
          sessionId: slot.sessionId,
          termId: slot.termId,
          slotIndex: slot.index,
        };
      });
    },

    "pool-wait": async (msg) => {
      const timeout = msg.timeout || 300000;

      if (msg.sessionId) {
        validateSessionId(msg.sessionId);
        try {
          const { slot } = findSlotBySessionId(msg.sessionId);
          await waitForSessionIdle(msg.sessionId, timeout);
          const buffer = await getTerminalBuffer(slot.termId);
          return { type: "result", sessionId: msg.sessionId, buffer };
        } catch (err) {
          return { type: "error", error: err.message, id: msg.id };
        }
      }

      // Wait by slot index (used by resume --block where session ID changes)
      if (msg.slotIndex !== undefined) {
        // Validate slot exists before entering poll loop
        findSlotByIndex(msg.slotIndex);
        try {
          const result = await poll(
            async () => {
              // Re-read pool each iteration: sessionId changes after /resume
              const pool = readPool();
              const slot = pool?.slots?.[msg.slotIndex];
              if (!slot?.sessionId) return null;
              const sessions = await getSessions();
              const session = sessions.find(
                (s) => s.sessionId === slot.sessionId,
              );
              if (session && session.status === STATUS.IDLE) return slot;
              if (session && !session.alive)
                throw new Error("Session process died");
              return null;
            },
            {
              interval: 1000,
              initialDelay: 1000,
              timeout,
              label: "waiting for slot to become idle",
            },
          );
          const buffer = await getTerminalBuffer(result.termId);
          return { type: "result", sessionId: result.sessionId, buffer };
        } catch (err) {
          return { type: "error", error: err.message, id: msg.id };
        }
      }

      // No sessionId or slotIndex: wait for any busy session to become idle
      const pool = readPool();
      if (!pool) throw new Error("Pool not initialized");
      const busySlots = pool.slots.filter((s) => s.status === POOL_STATUS.BUSY);
      if (busySlots.length === 0)
        throw new Error("No busy sessions to wait for");

      const finished = await poll(
        async () => {
          const sessions = await getSessions();
          for (const s of busySlots) {
            const session = sessions.find(
              (sess) => sess.sessionId === s.sessionId,
            );
            if (session && session.status === STATUS.IDLE) return s;
          }
          return null;
        },
        {
          interval: 1000,
          initialDelay: 1000,
          timeout,
          label: "waiting for session to become idle",
        },
      );

      const buffer = await getTerminalBuffer(finished.termId);
      return { type: "result", sessionId: finished.sessionId, buffer };
    },

    "pool-capture": async (msg) => {
      const { slot } = resolveSlot(msg);
      const buffer = await getTerminalBuffer(slot.termId);
      return {
        type: "buffer",
        sessionId: slot.sessionId,
        slotIndex: slot.index,
        buffer,
      };
    },

    "pool-result": async (msg) => {
      const { slot } = resolveSlot(msg);
      const status = await getEffectiveSlotStatus(slot);
      if (status === POOL_STATUS.BUSY || status === STATUS.PROCESSING) {
        throw new Error("Session is still running");
      }
      const buffer = await getTerminalBuffer(slot.termId);
      return {
        type: "result",
        sessionId: slot.sessionId,
        slotIndex: slot.index,
        buffer,
      };
    },

    "pool-input": async (msg) => {
      if (msg.data === undefined) throw new Error("data required");
      const { slot } = resolveSlot(msg);
      daemonSendSafe({ type: "write", termId: slot.termId, data: msg.data });
      return { type: "ok" };
    },

    "pool-clean": async () => {
      const cleaned = await poolClean();
      return { type: "cleaned", count: cleaned };
    },

    "pool-pin": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      const duration = msg.duration || 120;
      return withPoolLock(async () => {
        const { pool, slot } = findSlotBySessionId(msg.sessionId);
        slot.pinnedUntil = new Date(Date.now() + duration * 1000).toISOString();
        writePool(pool);
        return { type: "ok", pinnedUntil: slot.pinnedUntil };
      });
    },

    "pool-unpin": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      return withPoolLock(async () => {
        const { pool, slot } = findSlotBySessionId(msg.sessionId);
        delete slot.pinnedUntil;
        writePool(pool);
        return { type: "ok" };
      });
    },

    "pool-stop-session": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      const { slot } = findSlotBySessionId(msg.sessionId);
      // Escape interrupts Claude generation; send twice to dismiss any menu
      daemonSendSafe({ type: "write", termId: slot.termId, data: "\x1b" });
      await new Promise((r) => setTimeout(r, 200));
      daemonSendSafe({ type: "write", termId: slot.termId, data: "\x1b" });
      // Write idle signal after delay — the hook's stop trigger defers 5s
      // and may not fire on interruption. We write at 6s as a fallback,
      // only if no signal exists yet (hook wins if it fires first).
      const stopPid = slot.pid;
      const stopSessionId = msg.sessionId;
      if (stopPid) {
        setTimeout(async () => {
          const sigFile = path.join(IDLE_SIGNALS_DIR, String(stopPid));
          if (fs.existsSync(sigFile)) return; // hook already wrote it
          const transcript = (await findJsonlPath(stopSessionId)) || "";
          const cwd = (await getCwdFromJsonl(stopSessionId)) || "";
          const signal = JSON.stringify({
            cwd,
            session_id: stopSessionId,
            transcript,
            ts: Math.floor(Date.now() / 1000),
            trigger: "api-stop",
          });
          try {
            fs.writeFileSync(sigFile, signal + "\n");
          } catch {
            /* ignore — session may be dead */
          }
        }, 6000);
      }
      return { type: "ok", sessionId: msg.sessionId };
    },

    "archive-session": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      await archiveSession(msg.sessionId);
      return { type: "ok" };
    },

    "unarchive-session": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      unarchiveSession(msg.sessionId);
      return { type: "ok" };
    },

    "get-session-graph": async () => ({
      type: "session-graph",
      graph: readSessionGraph(),
    }),

    // --- Slot access commands (by index, works without sessionId) ---

    "slot-read": async (msg) => {
      const { slot } = findSlotByIndex(msg.slotIndex);
      const buffer = await getTerminalBuffer(slot.termId);
      return {
        type: "buffer",
        slotIndex: slot.index,
        sessionId: slot.sessionId,
        buffer,
      };
    },

    "slot-write": async (msg) => {
      if (msg.data === undefined) throw new Error("data required");
      const { slot } = findSlotByIndex(msg.slotIndex);
      daemonSendSafe({ type: "write", termId: slot.termId, data: msg.data });
      return { type: "ok" };
    },

    "slot-status": async (msg) => {
      const { slot } = findSlotByIndex(msg.slotIndex);
      const healthStatus = slot.sessionId
        ? await getEffectiveSlotStatus(slot)
        : slot.status;
      return {
        type: "slot",
        slot: {
          index: slot.index,
          termId: slot.termId,
          pid: slot.pid,
          status: slot.status,
          sessionId: slot.sessionId,
          healthStatus,
          createdAt: slot.createdAt,
        },
      };
    },

    // --- Session terminal access (per-session tab control) ---

    "session-terminals": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      const terminals = await getSessionTerminals(msg.sessionId);
      return {
        type: "terminals",
        terminals: terminals.map(({ buffer, ...rest }) => rest),
      };
    },

    "session-term-read": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      if (msg.tabIndex === undefined) throw new Error("tabIndex required");
      const terminals = await getSessionTerminals(msg.sessionId);
      const tab = terminals[msg.tabIndex];
      if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
      return { type: "buffer", termId: tab.termId, buffer: tab.buffer };
    },

    "session-term-write": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      if (msg.tabIndex === undefined) throw new Error("tabIndex required");
      if (msg.data === undefined) throw new Error("data required");
      const terminals = await getSessionTerminals(msg.sessionId);
      const tab = terminals[msg.tabIndex];
      if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
      daemonSendSafe({ type: "write", termId: tab.termId, data: msg.data });
      return { type: "ok" };
    },

    "session-term-open": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      validateSessionId(msg.sessionId);
      let cwd = msg.cwd;
      if (!cwd) {
        // Get cwd from existing terminals (cheaper than getSessions)
        const existing = await getSessionTerminals(msg.sessionId);
        if (existing.length > 0) cwd = existing[0].cwd;
      }
      const resp = await daemonRequest({
        type: "spawn",
        cwd: cwd || os.homedir(),
        sessionId: msg.sessionId,
      });
      // New terminal always gets highest termId, so tab index = count of existing
      const terminals = await getSessionTerminals(msg.sessionId);
      const newTab = terminals.find((t) => t.termId === resp.termId);
      // Notify renderer so it can attach and show the tab
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          "api-term-opened",
          msg.sessionId,
          resp.termId,
        );
      }
      return {
        type: "spawned",
        termId: resp.termId,
        tabIndex: newTab ? newTab.index : terminals.length - 1,
      };
    },

    "session-term-run": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      if (msg.tabIndex === undefined) throw new Error("tabIndex required");
      if (!msg.command) throw new Error("command required");
      const timeoutMs = msg.timeout || 30000;

      const terminals = await getSessionTerminals(msg.sessionId);
      const tab = terminals[msg.tabIndex];
      if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
      if (tab.isTui)
        throw new Error("Cannot run commands in the Claude TUI tab");

      // Snapshot current buffer
      const beforeBuffer = tab.buffer;

      // Write command + Enter
      daemonSendSafe({
        type: "write",
        termId: tab.termId,
        data: msg.command + "\r",
      });

      // Poll until a shell prompt appears after the command output
      const promptRe = /[\$❯%#>] *$/; /* common prompt endings */
      const deadline = Date.now() + timeoutMs;

      // Wait a short initial delay for the command to start producing output
      await new Promise((r) => setTimeout(r, 300));

      while (Date.now() < deadline) {
        const buf = await readTerminalBuffer(tab.termId);

        // Check if buffer has new content beyond what was there before,
        // and the last non-empty line looks like a shell prompt
        if (buf.length > beforeBuffer.length) {
          const newContent = buf.slice(beforeBuffer.length);
          const clean = stripAnsi(newContent);
          const lines = clean.split("\n").filter((l) => l.trim());
          if (lines.length > 1) {
            const lastLine = lines[lines.length - 1].trimEnd();
            if (promptRe.test(lastLine)) {
              // Extract output: everything between command echo and final prompt
              // Skip first line (command echo) and last line (prompt)
              const outputLines = lines.slice(1, -1);
              return {
                type: "output",
                output: outputLines.join("\n"),
                termId: tab.termId,
              };
            }
          }
        }

        await new Promise((r) => setTimeout(r, 200));
      }

      // Timeout — return whatever we have
      const finalBuf = await readTerminalBuffer(tab.termId);
      const delta = finalBuf.slice(beforeBuffer.length);
      throw new Error(
        `Command timed out after ${timeoutMs}ms. Partial output: ${stripAnsi(delta).trim()}`,
      );
    },

    "session-term-close": async (msg) => {
      if (!msg.sessionId) throw new Error("sessionId required");
      if (msg.tabIndex === undefined) throw new Error("tabIndex required");
      const terminals = await getSessionTerminals(msg.sessionId);
      const tab = terminals[msg.tabIndex];
      if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
      if (tab.isTui) {
        throw new Error("Cannot close the Claude TUI tab");
      }
      await daemonRequest({ type: "kill", termId: tab.termId });
      // Notify renderer so it can remove the tab
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          "api-term-closed",
          msg.sessionId,
          tab.termId,
        );
      }
      return { type: "ok" };
    },
  });

  const send = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // Build menu with keyboard shortcuts (dynamic from config)
  function buildMenu() {
    // Helper: only set accelerator if action has a binding and isn't input-event-only
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
            label: "Command Palette",
            accelerator: accel("toggle-command-palette"),
            click: () => send("toggle-command-palette"),
          },
          {
            label: "Pool Settings",
            accelerator: accel("open-pool-settings"),
            click: () => send("open-pool-settings"),
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

  // Load shortcuts config and build initial menu
  loadShortcuts();
  buildMenu();

  // IPC handlers for shortcut settings
  ipcMain.handle("get-shortcuts", () => getAllShortcuts());
  ipcMain.handle("get-default-shortcut", (_e, actionId) =>
    getDefaultShortcut(actionId),
  );
  ipcMain.handle("set-shortcut", (_e, actionId, accelerator) => {
    setShortcut(actionId, accelerator);
    buildMenu(); // Rebuild menu with updated accelerators
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
  // Electron doesn't await async before-quit handlers, so we must block
  // the quit until poolDestroy finishes to avoid orphaned processes.
  if (OWN_POOL && !ownPoolDestroyed) {
    e.preventDefault();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 5000),
    );
    Promise.race([poolDestroy(), timeout])
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
  closeDebugLog();
  // Disconnect from daemon (daemon keeps PTYs alive)
  if (daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.destroy();
  }
  for (const entry of pendingPolls) entry.cancel();
  pendingPolls.clear();
  // Clean up API socket
  try {
    fs.unlinkSync(API_SOCKET);
  } catch {
    /* ENOENT expected — socket may not exist */
  }
});

app.on("window-all-closed", () => {
  for (const file of fileWatchers.values()) fs.unwatchFile(file);
  if (daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.destroy();
  }
  if (process.platform !== "darwin") app.quit();
});
