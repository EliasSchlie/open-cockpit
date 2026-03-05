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
const { isTranscriptNewerThanSignal } = require("./session-status");
const { createApiServer } = require("./api-server");
const {
  readPool: readPoolFile,
  writePool: writePoolFile,
  computePoolHealth,
  syncStatuses,
  createSlot,
  selectShrinkCandidates,
  findSlotBySessionId: findSlotBySessionIdInPool,
  findSlotByIndex: findSlotByIndexInPool,
  resolveSlot: resolveSlotInPool,
} = require("./pool");

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
const POOL_FILE = path.join(OPEN_COCKPIT_DIR, "pool.json");
const SETUP_SCRIPTS_DIR = path.join(OPEN_COCKPIT_DIR, "setup-scripts");
const API_SOCKET = path.join(OPEN_COCKPIT_DIR, "api.sock");
const DEFAULT_POOL_SIZE = 5;

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

// Cache CWD from JSONL (sessionId -> cwd, rarely changes)
const cwdFromJsonlCache = new Map();

// Cache git root lookups (cwd -> gitRoot)
const gitRootCache = new Map();

// Cache JSONL path lookups (sessionId -> path)
const jsonlPathCache = new Map();

// If a "processing" session's transcript hasn't been written to in this long, treat as idle
const STALE_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes

// Deduplicate stale processing log messages (only log once per session)
const staleLoggedSessions = new Set();

// Cache hasUserInput results (transcript -> true, once true stays true)
const userInputCache = new Map();

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
    // Alt+Left / Alt+Right — toggle focus between terminal and editor
    if (
      input.alt &&
      (input.key === "ArrowLeft" || input.key === "ArrowRight")
    ) {
      event.preventDefault();
      mainWindow.webContents.send("toggle-pane-focus");
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

async function getJsonlMtime(sessionId) {
  let jsonlPath = jsonlPathCache.get(sessionId);
  if (!jsonlPath) jsonlPath = await findJsonlPath(sessionId);
  if (!jsonlPath) return null;
  try {
    const stat = await fs.promises.stat(jsonlPath);
    return stat.mtimeMs;
  } catch {
    jsonlPathCache.delete(sessionId);
    return null;
  }
}

async function getCwdFromJsonl(sessionId) {
  if (cwdFromJsonlCache.has(sessionId)) return cwdFromJsonlCache.get(sessionId);
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
      } catch {}
    }
    const result = cwd || null;
    if (result) cwdFromJsonlCache.set(sessionId, result);
    return result;
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

// Read idle signal for a PID. Returns {cwd, ts, trigger, session_id, signalMtimeMs} or null.
function getIdleSignal(pid) {
  try {
    const signalFile = path.join(IDLE_SIGNALS_DIR, String(pid));
    const stat = fs.statSync(signalFile);
    const parsed = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    parsed.signalMtimeMs = stat.mtimeMs;
    return parsed;
  } catch {
    return null;
  }
}

// Check if a session's JSONL transcript contains any human turn.
// Uses the transcript path from the idle signal to avoid a `find` call.
function hasUserInput(transcriptPath) {
  if (!transcriptPath) return false;
  if (userInputCache.get(transcriptPath)) return true;
  try {
    // Read in chunks — check early lines first (human turns appear near the start)
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(64 * 1024); // 64KB chunks
    let bytesRead;
    let offset = 0;
    const needle = '"type":"user"';
    try {
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, offset)) > 0) {
        if (buf.toString("utf-8", 0, bytesRead).includes(needle)) {
          userInputCache.set(transcriptPath, true);
          return true;
        }
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }
    return false;
  } catch {
    return false;
  }
}

// Read offloaded session metadata
function getOffloadedSessions() {
  if (!fs.existsSync(OFFLOADED_DIR)) return [];
  const sessions = [];
  for (const dir of fs.readdirSync(OFFLOADED_DIR)) {
    try {
      const meta = readOffloadMeta(dir);
      if (!meta) continue;
      const snapshotFile = path.join(OFFLOADED_DIR, dir, "snapshot.log");
      const hasSnapshot = fs.existsSync(snapshotFile);
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
        status: isArchived ? "archived" : "offloaded",
        idleTs: meta.lastInteractionTs || 0,
        claudeSessionId: meta.claudeSessionId || null,
        hasSnapshot,
        origin: meta.origin || null,
      });
    } catch {}
  }
  return sessions;
}

function findGitRoot(cwd) {
  if (!cwd) return null;
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    try {
      if (fs.statSync(dotGit).isDirectory()) {
        gitRootCache.set(cwd, dir);
        return dir;
      }
    } catch {}
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
    const intentionHeading = hasIntention
      ? getIntentionHeading(intentionFile)
      : null;

    const gitRoot = findGitRoot(cwd);

    // Determine session status: idle, processing, or fresh
    const idleSignal = alive ? getIdleSignal(pid) : null;
    let status;
    let idleTs = 0;
    let staleIdle = false;

    if (!alive) {
      status = "dead";
    } else if (idleSignal) {
      idleTs = idleSignal.ts || 0;
      if (
        isTranscriptNewerThanSignal(
          idleSignal.signalMtimeMs,
          idleSignal.transcript,
        )
      ) {
        // Transcript was written after the idle signal — a Stop hook re-prompted
        // Claude and it's still processing (no new idle signal yet)
        status = "processing";
      } else if (!hasUserInput(idleSignal.transcript)) {
        status = "fresh";
      } else {
        status = "idle";
      }
    } else {
      // Fallback: if transcript hasn't been written to in a while, treat as idle
      const mtime = await getJsonlMtime(sessionId);
      if (mtime && Date.now() - mtime > STALE_PROCESSING_MS) {
        if (!staleLoggedSessions.has(sessionId)) {
          staleLoggedSessions.add(sessionId);
          console.warn(
            `[main] Stale processing detected for session ${sessionId} (no activity for ${Math.round((Date.now() - mtime) / 1000)}s) — treating as idle. Idle signal hook may have failed.`,
          );
        }
        status = "idle";
        staleIdle = true;
        idleTs = mtime;
      } else {
        staleLoggedSessions.delete(sessionId);
        status = "processing";
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
      status,
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
    } catch {}
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
    if (s.status !== "dead") continue;

    const offloadDir = path.join(OFFLOADED_DIR, s.sessionId);
    if (!fs.existsSync(offloadDir)) {
      // Recover cwd from JSONL since lsof doesn't work on dead processes
      let cwd = s.cwd || (await getCwdFromJsonl(s.sessionId));
      let gitRoot = s.gitRoot || findGitRoot(cwd);
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
    } catch {}

    sessions.splice(i, 1);
  }

  // Tag sessions with origin: pool, sub-claude, or ext
  const pool = readPool();
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

  // Add offloaded/archived sessions, skip if live session exists
  const liveIds = new Set(sessions.map((s) => s.sessionId));
  for (const offloaded of getOffloadedSessions()) {
    if (!liveIds.has(offloaded.sessionId)) {
      if (!offloaded.origin) offloaded.origin = "pool";
      sessions.push(offloaded);
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
        } catch {}
      }
    }
    // Idle signal files
    if (fs.existsSync(IDLE_SIGNALS_DIR)) {
      const files = fs.readdirSync(IDLE_SIGNALS_DIR).sort();
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(IDLE_SIGNALS_DIR, f));
          parts.push(`i:${f}:${st.mtimeMs}`);
        } catch {}
      }
    }
    // Offloaded dir mtime (catches new archives)
    try {
      const st = fs.statSync(OFFLOADED_DIR);
      parts.push(`o:${st.mtimeMs}`);
    } catch {}
    // Pool state changes (new slots, killed sessions)
    try {
      const st = fs.statSync(POOL_FILE);
      parts.push(`pool:${st.mtimeMs}`);
    } catch {}
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
    return "";
  }
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
  // Get terminal buffer as snapshot
  let snapshot = null;
  try {
    const resp = await daemonRequest({ type: "list" });
    const pty = resp.ptys.find((p) => p.termId === termId);
    if (pty && pty.buffer) snapshot = pty.buffer;
  } catch (err) {
    console.error(
      "[main] Failed to get terminal snapshot for offload of session",
      sessionId,
      err.message,
    );
  }

  const meta = writeOffloadMeta(sessionId, {
    cwd,
    gitRoot,
    claudeSessionId,
    snapshot,
    origin: "pool",
  });

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
    } catch {}
    // Remove stale PID file so the old session doesn't appear as a live "idle"
    // ghost while /clear is in flight. The SessionStart hook will recreate it
    // with the new session UUID once /clear completes.
    try {
      fs.unlinkSync(path.join(SESSION_PIDS_DIR, String(pid)));
    } catch {}
  }

  // 4. Update pool slot: /clear keeps same PID but assigns a new session UUID
  await withPoolLock(() => {
    const pool = readPool();
    if (!pool) return;
    const slot = pool.slots.find((s) => s.termId === termId);
    if (!slot) return;
    const oldSessionId = slot.sessionId;
    slot.status = "fresh";
    slot.sessionId = null;
    writePool(pool);

    // Poll until the PID file changes from old UUID to new one
    pollForSessionId(slot.pid, 60000, oldSessionId)
      .then(async (newSessionId) => {
        await withPoolLock(() => {
          const p = readPool();
          if (!p) return;
          const s = p.slots.find((x) => x.termId === termId);
          if (s) {
            s.sessionId = newSessionId;
            s.status = newSessionId ? "fresh" : "error";
            writePool(p);
          }
        });
      })
      .catch((err) =>
        console.error("[main] Post-offload session poll failed:", err.message),
      );
  });

  return meta;
}

// Validate sessionId format to prevent path traversal
function validateSessionId(sessionId) {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    throw new Error("Invalid session ID format");
  }
}

// Write offload metadata (and optional snapshot) to disk for a session.
function writeOffloadMeta(
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
    ? getIntentionHeading(intentionFile)
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
function saveExternalClearOffload(oldSessionId, pid) {
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

  writeOffloadMeta(oldSessionId, { cwd, externalClear: true, origin: "ext" });
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
    // Wait a beat for offload meta to be written
    await new Promise((r) => setTimeout(r, 500));
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
      ? getIntentionHeading(intentionFile)
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
  } catch {}
}

// Read offload snapshot
function readOffloadSnapshot(sessionId) {
  validateSessionId(sessionId);
  const snapshotFile = path.join(OFFLOADED_DIR, sessionId, "snapshot.log");
  try {
    return fs.readFileSync(snapshotFile, "utf-8");
  } catch {
    return null;
  }
}

// Read offload meta
function readOffloadMeta(sessionId) {
  validateSessionId(sessionId);
  const metaFile = path.join(OFFLOADED_DIR, sessionId, "meta.json");
  try {
    return JSON.parse(fs.readFileSync(metaFile, "utf-8"));
  } catch {
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
  } catch {}
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

// Poll a terminal's buffer for the trust prompt and send Enter to accept it.
// Uses read-buffer (single terminal) instead of list (all terminals) to avoid
// socket contention when many slots poll simultaneously.
// Verifies the prompt was actually dismissed after sending Enter.
async function waitForTrustPromptAndAccept(termId, timeoutMs = 15000) {
  const POLL_INTERVAL = 200;
  const VERIFY_INTERVAL = 150;
  const VERIFY_TIMEOUT = 3000;
  const MAX_RETRIES = 3;
  const TRUST_PATTERNS = ["Do you trust", "trust the files"];

  const bufferHasTrustPrompt = (buffer) =>
    TRUST_PATTERNS.some((pat) => buffer.includes(pat));

  const readBuffer = async () => {
    const resp = await daemonRequest({ type: "read-buffer", termId });
    return resp.buffer || "";
  };

  let elapsed = 0;
  while (elapsed < timeoutMs) {
    let buffer;
    try {
      buffer = await readBuffer();
    } catch {
      return false; // Daemon gone
    }

    if (bufferHasTrustPrompt(buffer)) {
      // Trust prompt detected — send Enter and verify it was accepted
      for (let _attempt = 0; _attempt < MAX_RETRIES; _attempt++) {
        daemonSendSafe({ type: "write", termId, data: "\r" });
        // Verify the prompt disappeared
        const verifyStart = Date.now();
        while (Date.now() - verifyStart < VERIFY_TIMEOUT) {
          await new Promise((r) => setTimeout(r, VERIFY_INTERVAL));
          try {
            const newBuffer = await readBuffer();
            if (!bufferHasTrustPrompt(newBuffer)) return true; // Confirmed
          } catch {
            return false;
          }
        }
        // Prompt still there — retry
        console.warn(
          `[pool] Trust prompt still present after Enter (termId=${termId}), retrying...`,
        );
      }
      // All retries exhausted but prompt still present
      console.error(
        `[pool] Failed to dismiss trust prompt after ${MAX_RETRIES} retries (termId=${termId})`,
      );
      return false;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    elapsed += POLL_INTERVAL;
  }
  // Fallback: send Enter in case prompt appeared but wasn't pattern-matched
  daemonSendSafe({ type: "write", termId, data: "\r" });
  return false;
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

// Spawn a single Claude session via the PTY daemon. Returns a slot object.
async function spawnPoolSlot(index) {
  const claudePath = resolveClaudePath();
  const resp = await daemonRequest({
    type: "spawn",
    cwd: os.homedir(),
    cmd: claudePath,
    args: ["--dangerously-skip-permissions"],
    env: { OPEN_COCKPIT_POOL: "1" },
  });
  return createSlot(index, resp.termId, resp.pid);
}

// Initialize pool: spawn N Claude sessions via PTY daemon
async function poolInit(size) {
  return withPoolLock(async () => {
    size = Math.max(1, Math.min(20, size || DEFAULT_POOL_SIZE));
    const existing = readPool();
    if (existing) {
      throw new Error(
        `Pool already initialized (${existing.slots.length} slots)`,
      );
    }

    const pool = {
      version: 1,
      poolSize: size,
      createdAt: new Date().toISOString(),
      slots: [],
    };

    // Spawn each slot as a Claude session in a daemon terminal (parallel)
    const slots = await Promise.all(
      Array.from({ length: size }, (_, i) => spawnPoolSlot(i)),
    );
    pool.slots = slots;

    // Accept trust prompts: poll terminal buffers for the prompt, then send Enter
    await Promise.all(
      pool.slots.map((slot) => waitForTrustPromptAndAccept(slot.termId)),
    );

    // Wait for each slot to get a session ID (Claude starts and hooks write PID mapping).
    const results = await Promise.allSettled(
      pool.slots.map(async (slot) => {
        const sessionId = await pollForSessionId(slot.pid, 60000);
        slot.sessionId = sessionId;
        slot.status = sessionId ? "fresh" : "error";
        // Write idle signal so getSessions detects slot as "fresh" (no user input)
        if (sessionId) createFreshIdleSignal(slot.pid, sessionId);
      }),
    );
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(
          `Pool slot ${i} failed to initialize:`,
          result.reason?.message || result.reason,
        );
      }
    });

    writePool(pool);
    return pool;
  });
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
      { interval: 500, timeout: timeoutMs, label: `session ID for PID ${pid}` },
    );
  } catch {
    return null; // Timeout → null (preserves original behavior)
  }
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

      // Resolve session IDs in background (locked to avoid clobbering)
      for (const slot of newSlots) {
        pollForSessionId(slot.pid, 60000)
          .then(async (sessionId) => {
            await withPoolLock(() => {
              const current = readPool();
              if (!current) return;
              const s = current.slots.find((x) => x.termId === slot.termId);
              if (s) {
                s.sessionId = sessionId;
                s.status = sessionId ? "fresh" : "error";
                writePool(current);
              }
            });
          })
          .catch(async (err) => {
            console.error(
              "[main] Resize session poll failed for slot %s: %s",
              slot.termId,
              err.message,
            );
            await withPoolLock(() => {
              const current = readPool();
              if (!current) return;
              const s = current.slots.find((x) => x.termId === slot.termId);
              if (s && s.status === "starting") {
                s.status = "error";
                writePool(current);
              }
            });
          });
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
    let daemonPtys;
    try {
      const resp = await daemonRequest({ type: "list" });
      daemonPtys = new Map(resp.ptys.map((p) => [p.termId, p]));
    } catch {
      return; // Daemon not running — can't reconcile
    }

    for (const slot of pool.slots) {
      const pty = daemonPtys.get(slot.termId);
      if (!pty || pty.exited) {
        if (slot.status !== "dead") {
          slot.status = "dead";
          changed = true;
        }
        // Kill orphaned process by PID before restarting
        if (slot.pid) {
          try {
            process.kill(slot.pid, "SIGTERM");
          } catch {}
        }
        // Auto-restart dead slot
        try {
          const newSlot = await spawnPoolSlot(slot.index);
          slot.termId = newSlot.termId;
          slot.pid = newSlot.pid;
          slot.status = "starting";
          slot.sessionId = null;
          changed = true;
          // Accept trust prompt after spawning (runs in background)
          waitForTrustPromptAndAccept(newSlot.termId);
          pollForSessionId(slot.pid, 60000)
            .then(async (sessionId) => {
              await withPoolLock(() => {
                const p = readPool();
                if (!p) return;
                const s = p.slots.find((x) => x.index === slot.index);
                if (s) {
                  s.sessionId = sessionId;
                  s.status = sessionId ? "fresh" : "error";
                  writePool(p);
                  if (sessionId) createFreshIdleSignal(slot.pid, sessionId);
                }
              });
            })
            .catch((err) =>
              console.error(
                "[main] Reconcile session poll failed:",
                err.message,
              ),
            );
        } catch (err) {
          console.error(
            `[main] Failed to restart slot ${slot.index}:`,
            err.message,
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
            saveExternalClearOffload(slot.sessionId, slot.pid);
          }
          slot.sessionId = sessionId;
          slot.status = "fresh";
          changed = true;
        }
      }
    }

    if (changed) writePool(pool);
  });
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
      } catch {}
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
    }
    try {
      fs.unlinkSync(POOL_FILE);
    } catch {}
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
    return session && session.status === "idle";
  });
  let cleaned = 0;
  for (const slot of idleSlots) {
    const session = sessionMap.get(slot.sessionId);
    await offloadSession(slot.sessionId, slot.termId, null, {
      cwd: session?.cwd,
      gitRoot: session?.gitRoot,
      pid: slot.pid,
    });
    // Mark as archived so it moves to Archive section instead of staying in Recent
    const offloadedMeta = readOffloadMeta(slot.sessionId);
    if (offloadedMeta && !offloadedMeta.archived) {
      offloadedMeta.archived = true;
      offloadedMeta.archivedAt = new Date().toISOString();
      secureWriteFileSync(
        path.join(OFFLOADED_DIR, slot.sessionId, "meta.json"),
        JSON.stringify(offloadedMeta, null, 2),
      );
    }
    cleaned++;
  }
  return cleaned;
}

// Ensure a fresh pool slot exists, offloading the LRU idle session if needed.
// Find offload target from pool/sessions without acquiring lock.
// Returns offload info or null if a fresh slot already exists.
function findOffloadTarget(pool, sessionMap) {
  const hasFresh = pool.slots.some((s) => {
    if (s.status === "fresh") return true;
    const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
    return session && session.status === "fresh";
  });
  if (hasFresh) return null;

  const idleSlots = pool.slots.filter((s) => {
    const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
    return session && session.status === "idle";
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
      if (s.status === "fresh") return true;
      const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
      return session && session.status === "fresh";
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

    await sendCommandToTerminal(slot.termId, `/resume ${claudeSessionId}`);
    slot.status = "busy";
    writePool(pool);

    // Async: poll for session ID change after /resume triggers SessionStart hook
    pollForSessionId(slot.pid, 60000, oldSlotSessionId)
      .then(async (newSessionId) => {
        await withPoolLock(() => {
          const p = readPool();
          if (!p) return;
          const s = p.slots.find((x) => x.termId === slot.termId);
          if (s && newSessionId) {
            s.sessionId = newSessionId;
            writePool(p);
          }
        });
        if (newSessionId) {
          removeOffloadData(sessionId);
        }
        sessionsCache = null;
      })
      .catch((err) =>
        console.error("[main] Post-resume session poll failed:", err.message),
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
  if (!fs.existsSync(file)) {
    secureMkdirSync(INTENTIONS_DIR, { recursive: true });
    secureWriteFileSync(file, "");
  }

  // Use polling (fs.watchFile) — reliable on macOS unlike fs.watch
  fs.watchFile(file, { interval: 500 }, () => {
    try {
      const content = fs.readFileSync(file, "utf-8");
      // Skip if this is content we wrote ourselves
      if (content === lastWrittenContent.get(sessionId)) return;
      lastWrittenContent.set(sessionId, content);
      console.log("[main] External file change detected, sending to renderer");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("intention-changed", content);
      }
    } catch (err) {
      console.error(
        "[main] Failed to read intention file on change",
        file,
        err.message,
      );
    }
  });

  fileWatchers.set("current", file);
}

const pendingPolls = new Set();

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

  // Reconcile pool state with surviving daemon terminals
  try {
    await reconcilePool();
  } catch (err) {
    console.error("[main] Pool reconciliation failed:", err.message);
  }

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

  ipcMain.handle("get-dir-colors", () => {
    try {
      return JSON.parse(fs.readFileSync(COLORS_FILE, "utf-8"));
    } catch {
      return {};
    }
  });
  ipcMain.handle("get-sessions", async () => {
    const sessions = await getSessions();
    syncPoolStatuses(sessions);
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
      return [];
    }
  });
  ipcMain.handle("read-setup-script", (_e, name) => {
    const filePath = path.join(SETUP_SCRIPTS_DIR, path.basename(name));
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
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

  async function sendPromptToTerminal(termId, prompt) {
    await sendCommandToTerminal(termId, prompt);
  }

  async function getEffectiveSlotStatus(slot) {
    const sessions = await getSessions();
    const session = sessions.find((s) => s.sessionId === slot.sessionId);
    if (!session) return slot.status;
    if (session.status === "idle") return "idle";
    if (session.status === "processing") return "busy";
    if (session.status === "fresh") return "fresh";
    return slot.status;
  }

  function waitForSessionIdle(sessionId, timeoutMs = 300000) {
    return poll(
      async () => {
        const sessions = await getSessions();
        const session = sessions.find((s) => s.sessionId === sessionId);
        if (session && session.status === "idle") return true;
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
    "get-sessions": async () => ({
      type: "sessions",
      sessions: await getSessions(),
    }),
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
      return { type: "ok" };
    },
    "pty-spawn": async (msg) => {
      const resp = await daemonRequest({
        type: "spawn",
        cwd: msg.cwd,
        cmd: msg.cmd,
        args: msg.args,
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
      return withFreshSlot(async (pool, slot) => {
        await sendPromptToTerminal(slot.termId, msg.prompt);
        slot.status = "busy";
        writePool(pool);

        return {
          type: "started",
          sessionId: slot.sessionId,
          termId: slot.termId,
          slotIndex: slot.index,
        };
      });
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
        if (status !== "idle")
          throw new Error(`Session is ${status}, expected idle`);

        await sendPromptToTerminal(slot.termId, msg.prompt);
        slot.status = "busy";
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

      // No sessionId: wait for any busy session to become idle
      const pool = readPool();
      if (!pool) throw new Error("Pool not initialized");
      const busySlots = pool.slots.filter((s) => s.status === "busy");
      if (busySlots.length === 0)
        throw new Error("No busy sessions to wait for");

      const finished = await poll(
        async () => {
          const sessions = await getSessions();
          for (const s of busySlots) {
            const session = sessions.find(
              (sess) => sess.sessionId === s.sessionId,
            );
            if (session && session.status === "idle") return s;
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
      if (status === "busy" || status === "processing") {
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
  });

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
          label: "Toggle Pane Focus",
          accelerator: "Alt+Left",
          click: () => send("toggle-pane-focus"),
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
          label: "Jump to Recent Idle",
          accelerator: "CmdOrCtrl+J",
          click: () => send("jump-recent-idle"),
        },
        {
          label: "Archive Current Session",
          accelerator: "CmdOrCtrl+D",
          click: () => send("archive-current-session"),
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
  // Clean up API socket
  try {
    fs.unlinkSync(API_SOCKET);
  } catch {}
});

app.on("window-all-closed", () => {
  for (const file of fileWatchers.values()) fs.unwatchFile(file);
  if (daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.destroy();
  }
  if (process.platform !== "darwin") app.quit();
});
