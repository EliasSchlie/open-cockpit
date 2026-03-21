const path = require("path");
const fs = require("fs");
const os = require("os");
const platform = require("./platform");
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

/**
 * Write local archive metadata for a session.
 * This stores sidebar display info (cwd, gitRoot, intention) — NOT snapshots.
 * claude-pool owns session data; this is only for displaying archived sessions.
 */
async function writeArchiveMeta(
  sessionId,
  { cwd, gitRoot, claudeSessionId, origin } = {},
) {
  validateSessionId(sessionId);
  const offloadDir = path.join(OFFLOADED_DIR, sessionId);
  secureMkdirSync(offloadDir, { recursive: true });

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
    archivedAt: new Date().toISOString(),
    archived: true,
  };
  if (origin) meta.origin = origin;

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

/**
 * Read session output from claude-pool (JSONL transcript).
 * Falls back to local snapshot.log for legacy offloaded sessions.
 */
async function readSessionSnapshot(sessionId) {
  validateSessionId(sessionId);

  // Try claude-pool first (works for archived/offloaded sessions)
  if (_poolRegistry) {
    try {
      const result = await _poolRegistry.findPoolForSession(sessionId);
      if (result) {
        const resp = await result.client.capture(sessionId, {
          source: "jsonl",
          turns: 0,
          detail: "last",
        });
        return resp.content || null;
      }
    } catch {
      // Session not in any pool — fall through to local
    }
  }

  // Legacy fallback: local snapshot file
  const snapshotFile = path.join(OFFLOADED_DIR, sessionId, "snapshot.log");
  try {
    return fs.readFileSync(snapshotFile, "utf-8");
  } catch {
    return null;
  }
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
  const reg = _requireRegistry();
  // Get or create client — pool may not be running yet (init starts it)
  let client = reg.getClient(poolName);
  if (!client) {
    // Not in registry — connect (creates client even if daemon is down)
    client = await reg.connectPool(poolName || reg.DEFAULT_POOL_NAME);
  }
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

  // Unarchive on pool side first — if this fails, local state is preserved
  const result = await client.unarchive(sessionId);

  // Only update local state after successful pool-side unarchive
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
 * Archive a session and all its descendants via claude-pool.
 * claude-pool handles offloading (PTY teardown, state persistence) internally.
 * OC only writes local metadata for sidebar display.
 */
async function archiveSession(sessionId, { cwd, gitRoot, origin } = {}) {
  const client = await _requireRegistry().clientForSessionOrDefault(sessionId);
  validateSessionId(sessionId);
  const { invalidateSessionsCache } = getSessionDiscovery();

  // Delegate to claude-pool (recursive: true archives all descendants)
  try {
    await client.archive(sessionId, true);
  } catch (err) {
    _debugLog(
      "main",
      `claude-pool archive failed for ${sessionId}: ${err.message}`,
    );
  }

  // Write local archive metadata for sidebar display
  await writeArchiveMeta(sessionId, {
    cwd,
    gitRoot,
    claudeSessionId: sessionId,
    origin: origin || "pool",
  });

  // Also write local metadata for descendants
  const graph = readSessionGraph();
  const descendants = getDescendantsFromGraph(sessionId, graph);
  for (const childId of descendants) {
    try {
      await writeArchiveMeta(childId, {
        claudeSessionId: childId,
        origin: origin || "pool",
      });
    } catch (err) {
      _debugLog(
        "main",
        `Failed to write archive meta for child ${childId}: ${err.message}`,
      );
    }
  }

  invalidateSessionsCache();
}

/**
 * Unarchive a session: tell claude-pool + clean local metadata.
 */
async function unarchiveSession(sessionId) {
  validateSessionId(sessionId);
  const { invalidateSessionsCache } = getSessionDiscovery();

  // Tell claude-pool to unarchive first
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

  // Clean local archive metadata
  removeOffloadData(sessionId);
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
          await archiveSession(session.sessionId, {
            cwd: session.cwd,
            gitRoot: session.gitRoot,
          });
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

  // Archive metadata
  writeArchiveMeta,
  readOffloadMeta,
  readSessionSnapshot,
  removeOffloadData,
  validateSessionId,

  // Pool operations (delegated to claude-pool)
  poolInit,
  poolResize,
  poolDestroy,
  getPoolHealth,
  poolResume,
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
