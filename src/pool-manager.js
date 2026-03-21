const path = require("path");
const fs = require("fs");
const os = require("os");
const platform = require("./platform");
const { Terminal: HeadlessTerminal } = require("@xterm/headless");
const {
  secureMkdirSync,
  secureWriteFileSync,
  readJsonSync,
} = require("./secure-fs");
const { STATUS, POOL_STATUS, INITIATOR } = require("./session-statuses");
const {
  OFFLOADED_DIR,
  INTENTIONS_DIR,
  SESSION_GRAPH_FILE,
  SESSION_PIDS_DIR,
  DEFAULT_POOL_SIZE,
} = require("./paths");
// Lazy require to avoid circular dependency with session-discovery
function getSessionDiscovery() {
  return require("./session-discovery");
}

// --- Init pattern ---
let _debugLog = () => {};
let _onIntentionChanged = null;

/** @type {import('./pool-registry') | null} */
let _poolRegistry = null;

function init({ debugLog, onIntentionChanged, poolRegistry }) {
  if (debugLog) _debugLog = debugLog;
  _onIntentionChanged = onIntentionChanged;
  if (poolRegistry) _poolRegistry = poolRegistry;
}

function _requireRegistry() {
  if (!_poolRegistry)
    throw new Error("pool registry not initialized (call init first)");
  return _poolRegistry;
}

// --- Module-level state ---
const lastWrittenContent = new Map();
const fileWatchers = new Map();

// Last-known terminal dimensions from the renderer
let _terminalDims = null;

function setTerminalDims(cols, rows) {
  _terminalDims = { cols, rows };
}

// ============================================================
// Intention file management (unchanged)
// ============================================================

function readIntention(sessionId) {
  const file = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}

function writeIntention(sessionId, content) {
  secureMkdirSync(INTENTIONS_DIR, { recursive: true });
  lastWrittenContent.set(sessionId, content);
  secureWriteFileSync(path.join(INTENTIONS_DIR, `${sessionId}.md`), content);
}

function watchIntention(sessionId) {
  if (fileWatchers.has("current")) {
    fs.unwatchFile(fileWatchers.get("current"));
    fileWatchers.delete("current");
  }
  lastWrittenContent.delete(sessionId);

  const file = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  secureMkdirSync(INTENTIONS_DIR, { recursive: true });

  fs.watchFile(file, { interval: 500 }, () => {
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      console.error(
        "[main] Failed to read intention file on change",
        file,
        err.message,
      );
      return;
    }
    if (content === lastWrittenContent.get(sessionId)) return;
    lastWrittenContent.set(sessionId, content);
    console.log("[main] External file change detected, sending to renderer");
    if (_onIntentionChanged) _onIntentionChanged(content);
  });

  fileWatchers.set("current", file);
}

// ============================================================
// Session graph (parent-child tracking) — unchanged
// ============================================================

function readSessionGraph() {
  return readJsonSync(SESSION_GRAPH_FILE, {});
}

function writeSessionGraph(graph) {
  const data = JSON.stringify(graph, null, 2);
  const tmp = SESSION_GRAPH_FILE + ".tmp";
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, SESSION_GRAPH_FILE);
}

function recordSessionRelation(sessionId, parentSessionId, initiator) {
  const graph = readSessionGraph();
  graph[sessionId] = {
    parentSessionId: parentSessionId || null,
    initiator: initiator || INITIATOR.USER,
    createdAt: new Date().toISOString(),
  };
  writeSessionGraph(graph);
}

function detectParentFromPidAncestry(pid) {
  if (!pid) return null;
  let current;
  try {
    current = platform.getParentPidSync(String(pid));
  } catch {
    return null;
  }
  while (current && current !== "0" && current !== "1") {
    const pidFile = path.join(SESSION_PIDS_DIR, current);
    try {
      return fs.readFileSync(pidFile, "utf-8").trim();
    } catch {
      // Not a known session — keep walking
    }
    try {
      current = platform.getParentPidSync(current);
    } catch {
      break;
    }
  }
  return null;
}

function enrichSessionsWithGraphData(sessions) {
  const graph = readSessionGraph();
  let graphChanged = false;
  for (const s of sessions) {
    const rel = graph[s.sessionId];
    if (rel) {
      s.parentSessionId = rel.parentSessionId;
      s.initiator = rel.initiator;
    } else if (s.alive && s.pid) {
      const parentId = detectParentFromPidAncestry(s.pid);
      if (parentId && parentId !== s.sessionId) {
        graph[s.sessionId] = {
          parentSessionId: parentId,
          initiator: INITIATOR.MODEL,
          createdAt: new Date().toISOString(),
        };
        s.parentSessionId = parentId;
        s.initiator = INITIATOR.MODEL;
        graphChanged = true;
        _debugLog(
          "main",
          `auto-detected parent for ${s.sessionId}: ${parentId}`,
        );
      }
    }
  }
  if (graphChanged) writeSessionGraph(graph);
}

function getDescendantsFromGraph(sessionId, graph) {
  const result = [];
  const visited = new Set();
  function walk(id) {
    for (const [childId, entry] of Object.entries(graph)) {
      if (entry.parentSessionId === id && !visited.has(childId)) {
        visited.add(childId);
        walk(childId);
        result.push(childId);
      }
    }
  }
  walk(sessionId);
  return result;
}

// ============================================================
// Offload metadata — unchanged
// ============================================================

function validateSessionId(sessionId) {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    throw new Error("Invalid session ID format");
  }
}

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

async function writeOffloadMeta(
  sessionId,
  {
    cwd,
    gitRoot,
    claudeSessionId,
    snapshot,
    externalClear,
    origin,
    archived,
  } = {},
) {
  validateSessionId(sessionId);
  const offloadDir = path.join(OFFLOADED_DIR, sessionId);
  secureMkdirSync(offloadDir, { recursive: true });

  if (snapshot) {
    secureWriteFileSync(path.join(offloadDir, "snapshot.log"), snapshot);
  }

  const { getIntentionHeading } = getSessionDiscovery();
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
  if (archived) {
    meta.archived = true;
    meta.archivedAt = new Date().toISOString();
  }

  secureWriteFileSync(
    path.join(offloadDir, "meta.json"),
    JSON.stringify(meta, null, 2),
  );
  return meta;
}

function readOffloadMeta(sessionId) {
  validateSessionId(sessionId);
  return readJsonSync(path.join(OFFLOADED_DIR, sessionId, "meta.json"));
}

async function readOffloadSnapshot(sessionId) {
  validateSessionId(sessionId);
  const snapshotFile = path.join(OFFLOADED_DIR, sessionId, "snapshot.log");
  let text;
  try {
    text = fs.readFileSync(snapshotFile, "utf-8");
  } catch {
    return null;
  }
  if (text.includes("\x1b[")) {
    const rendered = await renderBufferToText(text);
    if (rendered != null) {
      try {
        secureWriteFileSync(snapshotFile, rendered);
      } catch {}
      return rendered;
    }
  }
  return text;
}

function removeOffloadData(sessionId) {
  validateSessionId(sessionId);
  const offloadDir = path.join(OFFLOADED_DIR, sessionId);
  try {
    fs.rmSync(offloadDir, { recursive: true });
  } catch (err) {
    _debugLog("main", "removeOffloadData failed for", sessionId, err.message);
  }
}

// ============================================================
// UI helpers — unchanged
// ============================================================

async function openInCursor(cwd) {
  if (!cwd) return;
  _debugLog("main", "openInCursor", cwd);

  const projectName = path.basename(cwd);
  const workspaceDir = path.join(
    os.homedir(),
    "Documents",
    "Projects",
    "VS code workspaces",
  );

  const namedWorkspace = path.join(
    workspaceDir,
    `${projectName}.code-workspace`,
  );
  if (fs.existsSync(namedWorkspace)) {
    await platform.openInCursor(namedWorkspace);
    return;
  }

  try {
    const entries = fs.readdirSync(cwd);
    const localWs = entries.find((e) => e.endsWith(".code-workspace"));
    if (localWs) {
      await platform.openInCursor(path.join(cwd, localWs));
      return;
    }
  } catch {}

  await platform.openInCursor(cwd);
}

async function withITermSessionByPid(pid, action, resultValue) {
  const tty = await platform.getProcessTty(pid);
  return platform.withITermSessionByTty(tty, action, resultValue);
}

async function closeExternalTerminal(pid) {
  if (!/^\d+$/.test(String(pid))) return { closed: false };
  const match = await withITermSessionByPid(pid, "close s", "closed");
  if (match) return { closed: true, ...match };
  try {
    process.kill(Number(pid), "SIGTERM");
    return { closed: true, app: "process" };
  } catch {
    return { closed: false };
  }
}

async function focusExternalTerminal(pid) {
  if (!/^\d+$/.test(String(pid))) return { focused: false };
  const match = await withITermSessionByPid(
    pid,
    "select t\n          set index of w to 1\n          activate",
    "focused",
  );
  if (match) return { focused: true, ...match };

  const TERMINAL_APPS = [
    { match: /\bCursor(\.app)?\b/, app: "Cursor", activate: "Cursor" },
    {
      match: /\bCode(\.app)?\b/,
      app: "VS Code",
      activate: "Visual Studio Code",
    },
  ];
  try {
    let checkPid = String(pid);
    for (let i = 0; i < 10; i++) {
      const ppid = await platform.getParentPid(checkPid);
      if (!ppid || ppid === "0" || ppid === "1") break;
      const pname = await platform.getProcessName(ppid);
      if (pname) {
        for (const { match: m, app, activate } of TERMINAL_APPS) {
          if (m.test(pname)) {
            await platform.activateApp(activate);
            return { focused: true, app };
          }
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

// ============================================================
// parseFlags helper — unchanged
// ============================================================

function parseFlags(flagStr) {
  if (!flagStr || !flagStr.trim()) return [];
  const args = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of flagStr) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
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

// ============================================================
// Pool operations — delegated to claude-pool
// ============================================================

/**
 * Initialize pool: start claude-pool daemon and create sessions.
 */
async function poolInit(size, poolName) {
  const client = _requireRegistry().requireConnectedClient(poolName);
  size = Math.max(1, Math.min(20, size || DEFAULT_POOL_SIZE));
  const flags = await getPoolFlags(poolName);
  const result = await client.init(size, flags);
  _debugLog("main", `poolInit: claude-pool initialized with ${size} slots`);
  return result;
}

/**
 * Resize pool to newSize slots.
 */
async function poolResize(newSize, poolName) {
  const client = _requireRegistry().requireConnectedClient(poolName);
  newSize = Math.max(1, Math.min(20, newSize));
  const result = await client.resize(newSize);
  _debugLog("main", `poolResize: resized to ${newSize}`);
  return result;
}

/**
 * Destroy pool: stop all sessions and daemon.
 */
async function poolDestroy(poolName) {
  const client = _requireRegistry().requireConnectedClient(poolName);
  try {
    const result = await client.destroyPool();
    _debugLog("main", "poolDestroy: pool destroyed via claude-pool");
    return result;
  } catch (err) {
    _debugLog("main", `poolDestroy failed: ${err.message}`);
  }
}

/**
 * Get pool health from claude-pool.
 */
async function getPoolHealth(poolName) {
  const client = _requireRegistry().requireConnectedClient(poolName);
  return client.health();
}

/**
 * Resume (unarchive) a session via claude-pool.
 */
async function poolResume(sessionId) {
  const client = await _requireRegistry().clientForSessionOrDefault(sessionId);
  validateSessionId(sessionId);

  // Unarchive local offload meta if present
  const meta = readOffloadMeta(sessionId);
  if (meta?.archived) {
    delete meta.archived;
    delete meta.archivedAt;
    secureWriteFileSync(
      path.join(OFFLOADED_DIR, sessionId, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
  }

  const result = await client.unarchive(sessionId);

  // Remove local offload data after successful resume
  removeOffloadData(sessionId);

  const { invalidateSessionsCache } = getSessionDiscovery();
  invalidateSessionsCache();

  _debugLog(
    "main",
    `poolResume: unarchived session ${sessionId} via claude-pool`,
  );
  return result;
}

/**
 * Offload a session: capture snapshot from claude-pool, save locally, then archive.
 */
async function offloadSession(
  sessionId,
  _termId,
  claudeSessionId,
  { cwd, gitRoot, pid } = {},
) {
  const client = await _requireRegistry().clientForSessionOrDefault(sessionId);
  validateSessionId(sessionId);

  // 1. Capture terminal buffer from claude-pool
  let snapshot = null;
  try {
    const resp = await client.capture(sessionId, { source: "buffer" });
    if (resp.content) snapshot = await renderBufferToText(resp.content);
  } catch (err) {
    console.error(
      "[main] Failed to get terminal snapshot for offload of session",
      sessionId,
      err.message,
    );
  }

  // 2. Write local offload metadata + snapshot
  const meta = await writeOffloadMeta(sessionId, {
    cwd,
    gitRoot,
    claudeSessionId,
    snapshot,
    origin: "pool",
  });

  // 3. Tell claude-pool to archive the session
  try {
    await client.archive(sessionId);
  } catch (err) {
    _debugLog(
      "main",
      `claude-pool archive failed for ${sessionId}: ${err.message}`,
    );
  }

  return meta;
}

/**
 * Archive a session and all its descendants (cascade via claude-pool recursive).
 */
async function archiveSession(sessionId) {
  const client = await _requireRegistry().clientForSessionOrDefault(sessionId);
  validateSessionId(sessionId);
  const { invalidateSessionsCache } = getSessionDiscovery();

  // Delegate cascade to claude-pool (recursive: true archives all descendants)
  try {
    await client.archive(sessionId, true);
  } catch (err) {
    _debugLog(
      "main",
      `claude-pool recursive archive failed for ${sessionId}: ${err.message}`,
    );
  }

  // Ensure local offload metadata is marked archived
  await archiveSingleSession(sessionId);

  // Also mark local metadata for descendants
  const graph = readSessionGraph();
  const descendants = getDescendantsFromGraph(sessionId, graph);
  for (const childId of descendants) {
    try {
      await archiveSingleSession(childId);
    } catch (err) {
      _debugLog(
        "main",
        `Failed to mark local archive for child ${childId}: ${err.message}`,
      );
    }
  }

  invalidateSessionsCache();
}

/**
 * Archive a single session locally (mark metadata as archived).
 * Does NOT call claude-pool — caller is responsible for pool-side archive.
 */
async function archiveSingleSession(sessionId) {
  validateSessionId(sessionId);
  const meta = readOffloadMeta(sessionId);

  if (meta) {
    meta.archived = true;
    meta.archivedAt = meta.archivedAt || new Date().toISOString();
    secureWriteFileSync(
      path.join(OFFLOADED_DIR, sessionId, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
  } else {
    await writeOffloadMeta(sessionId, {
      claudeSessionId: sessionId,
      archived: true,
    });
  }
}

/**
 * Unarchive a session: update local meta + tell claude-pool.
 */
async function unarchiveSession(sessionId) {
  validateSessionId(sessionId);
  const { invalidateSessionsCache } = getSessionDiscovery();
  const meta = readOffloadMeta(sessionId);
  if (!meta) return;
  delete meta.archived;
  delete meta.archivedAt;
  secureWriteFileSync(
    path.join(OFFLOADED_DIR, sessionId, "meta.json"),
    JSON.stringify(meta, null, 2),
  );

  // Tell claude-pool to unarchive (restores to offloaded state)
  if (_poolRegistry) {
    try {
      const result = await _poolRegistry.findPoolForSession(sessionId);
      if (result) await result.client.unarchive(sessionId);
    } catch (err) {
      _debugLog(
        "main",
        `claude-pool unarchive failed for ${sessionId}: ${err.message}`,
      );
    }
  }

  invalidateSessionsCache();
}

/**
 * Clean pool: archive all idle sessions.
 */
async function poolClean(poolName) {
  if (!_poolRegistry) throw new Error("pool registry not initialized");

  let cleaned = 0;
  const clients = poolName
    ? [[poolName, _requireRegistry().requireConnectedClient(poolName)]]
    : [..._poolRegistry.getConnectedClients()];

  for (const [, client] of clients) {
    try {
      const resp = await client.ls({ statuses: ["idle"] });
      if (!resp.sessions || resp.sessions.length === 0) continue;

      for (const session of resp.sessions) {
        try {
          await offloadSession(session.sessionId, null, null, {
            cwd: session.cwd,
            gitRoot: session.gitRoot,
            pid: session.pid,
          });
          await archiveSession(session.sessionId);
          cleaned++;
        } catch (err) {
          _debugLog(
            "main",
            `poolClean failed for ${session.sessionId}: ${err.message}`,
          );
        }
      }
    } catch (err) {
      _debugLog("main", `poolClean failed for pool: ${err.message}`);
    }
  }
  return cleaned;
}

// ============================================================
// Pool settings — delegated to claude-pool config
// ============================================================

async function getPoolFlags(poolName) {
  try {
    const client = _requireRegistry().requireConnectedClient(poolName);
    const resp = await client.config();
    return resp.config?.flags ?? "--dangerously-skip-permissions";
  } catch {
    return "--dangerously-skip-permissions";
  }
}

async function setPoolFlags(flags, poolName) {
  if (typeof flags !== "string") throw new Error("flags must be a string");
  const client = _requireRegistry().requireConnectedClient(poolName);
  await client.config({ flags });
}

async function getMinFreshSlots(poolName) {
  try {
    const client = _requireRegistry().requireConnectedClient(poolName);
    const resp = await client.config();
    const val = resp.config?.keepFresh;
    return typeof val === "number" && val >= 0 ? val : 1;
  } catch {
    return 1;
  }
}

async function setMinFreshSlots(n, poolName) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new Error("minFreshSlots must be a non-negative number");
  }
  const client = _requireRegistry().requireConnectedClient(poolName);
  await client.config({ keepFresh: n });
}

// ============================================================
// Compatibility shims — kept for callers that still reference them
// ============================================================

// resolveClaudePath is still used by first-run.js
function resolveClaudePath() {
  return platform.resolveClaudePath();
}

let _cachedClaudePath = null;
function getCachedClaudePath() {
  if (!_cachedClaudePath) _cachedClaudePath = resolveClaudePath();
  return _cachedClaudePath;
}

// Validate termId — accepts both string (claude-term) and number (legacy)
function validateTermId(termId) {
  if (!termId) {
    throw new Error("termId is required");
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Init
  init,

  // Intention files
  readIntention,
  writeIntention,
  watchIntention,
  lastWrittenContent,
  fileWatchers,

  // Session graph
  readSessionGraph,
  writeSessionGraph,
  recordSessionRelation,
  enrichSessionsWithGraphData,
  getDescendantsFromGraph,

  // Offload metadata
  writeOffloadMeta,
  readOffloadMeta,
  readOffloadSnapshot,
  removeOffloadData,
  renderBufferToText,
  validateSessionId,

  // Pool operations (delegated to claude-pool)
  poolInit,
  poolResize,
  poolDestroy,
  getPoolHealth,
  poolResume,
  offloadSession,
  archiveSession,
  unarchiveSession,
  poolClean,

  // Pool settings (delegated to claude-pool config)
  getPoolFlags,
  setPoolFlags,
  getMinFreshSlots,
  setMinFreshSlots,

  // UI helpers
  openInCursor,
  focusExternalTerminal,
  closeExternalTerminal,
  setTerminalDims,

  // Utilities
  parseFlags,
  stripAnsi,
  resolveClaudePath,
  getCachedClaudePath,
  validateTermId,
};
