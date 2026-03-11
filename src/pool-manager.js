const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  execFile,
  execFileSync,
  execSync,
  spawn: spawnChild,
} = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const platform = require("./platform");
const { Terminal: HeadlessTerminal } = require("@xterm/headless");
const { createPoolLock } = require("./pool-lock");
const {
  secureMkdirSync,
  secureWriteFileSync,
  readJsonSync,
} = require("./secure-fs");
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
  findOffloadTarget,
} = require("./pool");
const { STATUS, POOL_STATUS, INITIATOR } = require("./session-statuses");
const {
  daemonSend,
  daemonSendSafe,
  daemonRequest,
  ensureDaemon,
} = require("./daemon-client");
const {
  POOL_FILE,
  POOL_SETTINGS_FILE,
  IDLE_SIGNALS_DIR,
  SESSION_PIDS_DIR,
  OFFLOADED_DIR,
  INTENTIONS_DIR,
  SESSION_GRAPH_FILE,
  DEFAULT_POOL_SIZE,
  ORPHAN_TERMINAL_TTL_MS,
  OPEN_COCKPIT_DIR,
  ACTIVE_SESSIONS_FILE,
  isPidAlive,
} = require("./paths");
const {
  readActiveRegistry,
  unregisterActiveSession,
  getSessionsToRestore,
  syncRegistryWithPool,
  setRestoreInProgress,
} = require("./active-sessions");

// Lazy require to avoid circular dependency with session-discovery
function getSessionDiscovery() {
  return require("./session-discovery");
}

// --- Init pattern for callbacks ---
let _debugLog = () => {};
let _onIntentionChanged = null; // for watchIntention to notify renderer
let _onPoolSlotsRecovered = null; // for reconcilePool to notify renderer

function init({ debugLog, onIntentionChanged, onPoolSlotsRecovered }) {
  if (debugLog) _debugLog = debugLog;
  _onIntentionChanged = onIntentionChanged;
  _onPoolSlotsRecovered = onPoolSlotsRecovered;
}

// --- Module-level state ---
let _cachedClaudePath = null;
const lastWrittenContent = new Map();
const fileWatchers = new Map();

// Last-known terminal dimensions from the renderer, used when spawning pool
// PTYs so they start at the actual window size instead of the 80×24 default.
let _terminalDims = null;

function setTerminalDims(cols, rows) {
  _terminalDims = { cols, rows };
}

const { withPoolLock } = createPoolLock();

// Sessions currently being restored (prevents double-restore races).
// Added synchronously at poolResume entry, removed when tracking completes.
const _pendingRestores = new Set();

// Sessions currently being offloaded by withFreshSlot (prevents TOCTOU race
// where two concurrent callers both offload an idle session but only one
// gets a fresh slot). Added inside the lock, removed after slot claim.
const _pendingOffloads = new Set();

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
function createFreshIdleSignal(
  pid,
  sessionId,
  { trigger = "pool-init", transcript = "" } = {},
) {
  secureMkdirSync(IDLE_SIGNALS_DIR, { recursive: true });
  secureWriteFileSync(
    path.join(IDLE_SIGNALS_DIR, String(pid)),
    JSON.stringify({
      cwd: os.homedir(),
      session_id: sessionId,
      transcript,
      ts: Math.floor(Date.now() / 1000),
      trigger,
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
  // Session is no longer active — remove from crash-recovery registry
  try {
    unregisterActiveSession(sessionId);
  } catch {}
  // Clean up terminal input cache for the offloaded slot
  const { terminalHasInputCache } = getSessionDiscovery();
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

// Walk PPID chain for a process, checking each ancestor against session-pids/.
// Returns the parent session ID if found, null otherwise.
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
      // Session not in graph — auto-detect parent from PID ancestry.
      // Only for alive sessions (dead PIDs can't be walked).
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

// Save offload metadata for a session that was cleared externally (e.g. /clear in terminal)
async function saveExternalClearOffload(oldSessionId, pid) {
  validateSessionId(oldSessionId);
  const offloadDir = path.join(OFFLOADED_DIR, oldSessionId);
  if (fs.existsSync(offloadDir)) return; // already offloaded

  // Gather what metadata we can
  let cwd = null;
  if (pid) {
    cwd = platform.getCwdSync(pid);
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
// Get all descendant session IDs from the graph, depth-first (deepest first).
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

// Archive a single session (no cascade). Handles live pool sessions, offloaded,
// and dead sessions. Callers handle invalidateSessionsCache().
async function archiveSingleSession(sessionId) {
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
    return;
  }

  // Live session — need to offload first if it's a pool session
  const pool = readPool();
  const slot = pool?.slots?.find((s) => s.sessionId === sessionId);
  if (slot) {
    // Pool session: offload it first, then mark archived
    const { getSessions } = getSessionDiscovery();
    const sessions = await getSessions();
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
    await writeOffloadMeta(sessionId, {
      claudeSessionId: sessionId,
      archived: true,
    });
  }
  killOrphanedTerminals(sessionId);
}

// Archive a session and all its descendants (cascade, depth-first).
async function archiveSession(sessionId) {
  validateSessionId(sessionId);
  const { invalidateSessionsCache } = getSessionDiscovery();

  // Cascade: archive all descendants depth-first (deepest first)
  const graph = readSessionGraph();
  const descendants = getDescendantsFromGraph(sessionId, graph);
  for (const childId of descendants) {
    try {
      await archiveSingleSession(childId);
    } catch (err) {
      _debugLog(
        "main",
        `Failed to cascade-archive child ${childId}: ${err.message}`,
      );
    }
  }

  await archiveSingleSession(sessionId);
  invalidateSessionsCache();
}

// Unarchive a session: remove the archived flag from its meta.
function unarchiveSession(sessionId) {
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
  invalidateSessionsCache();
}

// Remove offload data for a session (after resume)
function removeOffloadData(sessionId) {
  validateSessionId(sessionId);
  const offloadDir = path.join(OFFLOADED_DIR, sessionId);
  try {
    fs.rmSync(offloadDir, { recursive: true });
  } catch (err) {
    _debugLog("main", "removeOffloadData failed for", sessionId, err.message);
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
  return readJsonSync(path.join(OFFLOADED_DIR, sessionId, "meta.json"));
}

// --- Pool Management ---

function resolveClaudePath() {
  return platform.resolveClaudePath();
}

function readPool() {
  return readPoolFile(POOL_FILE);
}

function writePool(pool) {
  writePoolFile(POOL_FILE, pool);
  const { invalidateSessionsCache } = getSessionDiscovery();
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
    _debugLog("main", `Trust prompt not detected for termId=${termId}`);
  }
}

// Cached claude binary path — resolved once, reused for all spawns.
function getCachedClaudePath() {
  if (!_cachedClaudePath) _cachedClaudePath = resolveClaudePath();
  return _cachedClaudePath;
}

// --- Pool settings (persistent flags for spawned sessions) ---

const DEFAULT_POOL_FLAGS = "--dangerously-skip-permissions";

function readPoolSettings() {
  return readJsonSync(POOL_SETTINGS_FILE, {});
}

function writePoolSettings(settings) {
  secureWriteFileSync(POOL_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getPoolFlags() {
  const settings = readPoolSettings();
  return settings.flags !== undefined ? settings.flags : DEFAULT_POOL_FLAGS;
}

function setPoolFlags(flags) {
  if (typeof flags !== "string") throw new Error("flags must be a string");
  const settings = readPoolSettings();
  settings.flags = flags;
  writePoolSettings(settings);
}

const DEFAULT_MIN_FRESH_SLOTS = 1;

function getMinFreshSlots() {
  const settings = readPoolSettings();
  const val = settings.minFreshSlots;
  return typeof val === "number" && val >= 0 ? val : DEFAULT_MIN_FRESH_SLOTS;
}

function setMinFreshSlots(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
    throw new Error("minFreshSlots must be a non-negative number");
  const settings = readPoolSettings();
  settings.minFreshSlots = n;
  writePoolSettings(settings);
}

// Parse a flags string into an array of arguments.
// Handles quoted strings and backslash escapes.
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

// Parse and cache pool flags once for a batch of spawns.
function getPoolArgs() {
  return parseFlags(getPoolFlags());
}

// Spawn a single Claude session via the PTY daemon. Returns a slot object.
// Pass pre-parsed args from getPoolArgs() to avoid redundant disk reads.
async function spawnPoolSlot(index, args) {
  if (!args) args = getPoolArgs();
  const claudePath = getCachedClaudePath();
  const dims = _terminalDims;
  const resp = await daemonRequest({
    type: "spawn",
    cwd: os.homedir(),
    cmd: claudePath,
    args,
    env: {
      OPEN_COCKPIT_POOL: "1",
      OPEN_COCKPIT_DIR: OPEN_COCKPIT_DIR,
    },
    // Use last-known terminal dimensions so Claude's TUI starts at the
    // correct size. Falls back to daemon default (80×24) on first launch.
    ...dims,
  });
  return createSlot(index, resp.termId, resp.pid);
}

// Restore sessions from the active-sessions registry.
// Compares registry entries against live pool slots and resumes any missing ones.
// This is the primary crash-recovery mechanism — runs on every reconcilePool cycle.
let _registryRestoreInProgress = false;
async function restoreFromActiveRegistry() {
  if (_registryRestoreInProgress) return;
  _registryRestoreInProgress = true;
  setRestoreInProgress(true);
  try {
    const pool = readPool();
    if (!pool) return;

    // Build set of live session IDs from pool
    const liveSessionIds = new Set();
    for (const slot of pool.slots) {
      if (slot.sessionId) liveSessionIds.add(slot.sessionId);
    }

    const toRestore = getSessionsToRestore(liveSessionIds);
    if (toRestore.length === 0) return;

    // Filter: skip agent-spawned sessions
    const graph = readSessionGraph();
    const userSessionIds = toRestore.filter((sessionId) => {
      const graphEntry = graph[sessionId];
      return !graphEntry || graphEntry.initiator !== INITIATOR.MODEL;
    });

    if (userSessionIds.length === 0) {
      // Clean stale agent entries from registry
      for (const sessionId of toRestore) {
        try {
          unregisterActiveSession(sessionId);
        } catch (err) {
          _debugLog(
            "main",
            `Failed to unregister agent session: ${err.message}`,
          );
        }
      }
      return;
    }

    _debugLog(
      "main",
      `Active registry: restoring ${userSessionIds.length} sessions`,
    );

    // Wait for fresh slots to become available
    try {
      await poll(
        () => {
          const p = readPool();
          if (!p) return false;
          const freshCount = p.slots.filter(
            (s) => s.status === POOL_STATUS.FRESH,
          ).length;
          return freshCount >= userSessionIds.length;
        },
        {
          interval: 500,
          timeout: 60000,
          label: "wait for fresh slots (registry)",
        },
      );
    } catch {
      _debugLog(
        "main",
        "Timed out waiting for fresh slots for registry restore",
      );
      return;
    }

    let restored = 0;
    for (const sessionId of userSessionIds) {
      try {
        await poolResume(sessionId);
        restored++;
        _debugLog("main", `Registry-restored session ${sessionId}`);
      } catch (err) {
        _debugLog(
          "main",
          `Failed to registry-restore ${sessionId}: ${err.message}`,
        );
      }
      // Remove from registry regardless (now either restored or unrestorable)
      try {
        unregisterActiveSession(sessionId);
      } catch (err) {
        _debugLog("main", `Failed to unregister session: ${err.message}`);
      }
    }

    if (restored > 0) {
      _debugLog(
        "main",
        `Registry restore complete: ${restored}/${userSessionIds.length}`,
      );
    }
  } finally {
    _registryRestoreInProgress = false;
    setRestoreInProgress(false);
  }
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
    const args = getPoolArgs();
    p.slots = await Promise.all(
      Array.from({ length: size }, (_, i) => spawnPoolSlot(i, args)),
    );

    writePool(p);
    return p;
  });

  // Track all slots in background (fire-and-forget, like poolResize).
  for (const slot of pool.slots) {
    trackNewSlot(slot);
  }

  // Auto-restore sessions from a previous pool (fire-and-forget).
  // Runs after slot tracking starts so fresh slots become available.
  restoreFromActiveRegistry().catch((err) =>
    _debugLog("main", `Session restore failed: ${err.message}`),
  );

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
    onError = null,
  } = {},
) {
  if (!skipTrustPrompt) acceptTrustPrompt(slot.termId);
  return pollForSessionId(slot.pid, timeout, excludeId)
    .then(async (sessionId) => {
      // Clear stale terminal input cache when slot gets a new session
      const { terminalHasInputCache } = getSessionDiscovery();
      terminalHasInputCache.delete(slot.termId);
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
              _debugLog(
                "main",
                `Slot resume failed: termId=${slot.termId} pid=${slot.pid} — no session ID`,
              );
            }
          } else {
            s.status = sessionId ? POOL_STATUS.FRESH : POOL_STATUS.ERROR;
            if (sessionId) {
              createFreshIdleSignal(s.pid, sessionId);
            } else {
              _debugLog(
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
      _debugLog(
        "main",
        `Slot tracking failed: termId=${slot.termId} pid=${slot.pid} err=${err.message}`,
      );
      if (onError) onError(err);
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
      const args = getPoolArgs();
      const newSlots = await Promise.all(
        Array.from({ length: newSize - currentSize }, (_, j) =>
          spawnPoolSlot(currentSize + j, args),
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
  const { getSessions } = getSessionDiscovery();
  const pool = readPool();
  const sessions = await getSessions();
  return computePoolHealth(pool, sessions, isPidAlive);
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
    const alive = isPidAlive(pid);
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
  await withPoolLock(async () => {
    // Clean up stale temp files from previous writes/crashes
    try {
      const dir = path.dirname(POOL_FILE);
      const base = path.basename(POOL_FILE);
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(base) && f.endsWith(".tmp")) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    } catch {}

    const pool = readPool();
    if (!pool) {
      _debugLog("reconcile", "no pool file — skipping");
      return;
    }

    const { terminalHasInputCache } = getSessionDiscovery();
    let changed = false;
    const recovered = [];
    const spawnArgs = getPoolArgs();
    let daemonPtys;
    try {
      const resp = await daemonRequest({ type: "list" });
      daemonPtys = new Map(resp.ptys.map((p) => [p.termId, p]));
      _debugLog(
        "reconcile",
        `pool has ${pool.slots.length} slots, daemon has ${daemonPtys.size} PTYs`,
      );
    } catch {
      _debugLog("reconcile", "daemon not running — skipping");
      return; // Daemon not running — can't reconcile
    }

    // If all slots are dead (daemon crash), save restore list
    // BEFORE overwriting slots with fresh ones.
    const allDead = pool.slots.every((slot) => {
      const pty = daemonPtys.get(slot.termId);
      return !pty || pty.exited;
    });
    // No special handling needed for allDead — restoreFromActiveRegistry
    // runs after every reconcile and handles crash recovery.

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
        // Auto-offload session before killing, so it stays discoverable
        // in the sidebar. poolResume doesn't need offload meta anymore,
        // but the sidebar only shows offloaded sessions that have meta.
        if (slot.sessionId && !readOffloadMeta(slot.sessionId)) {
          try {
            await writeOffloadMeta(slot.sessionId, {
              claudeSessionId: slot.sessionId,
              origin: "pool",
            });
            _debugLog(
              "main",
              `Auto-offloaded session ${slot.sessionId} before slot recovery`,
            );
          } catch (err) {
            _debugLog(
              "main",
              `Failed to auto-offload ${slot.sessionId}: ${err.message}`,
            );
          }
        }
        // Kill old process/PTY before restarting
        await killSlotProcess(slot);
        // Auto-restart slot
        try {
          _debugLog(
            "main",
            `Auto-recovering ${reason} slot ${slot.index} (termId=${slot.termId} pid=${slot.pid})`,
          );
          const newSlot = await spawnPoolSlot(slot.index, spawnArgs);
          slot.termId = newSlot.termId;
          slot.pid = newSlot.pid;
          slot.status = POOL_STATUS.STARTING;
          slot.sessionId = null;
          changed = true;
          recovered.push({ index: slot.index, reason });
          trackNewSlot(slot);
        } catch (err) {
          _debugLog(
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
          // Clear stale terminal input cache for this slot (prevents ghost TYPING)
          terminalHasInputCache.delete(slot.termId);
          slot.sessionId = sessionId;
          slot.status = POOL_STATUS.FRESH;
          createFreshIdleSignal(slot.pid, sessionId);
          changed = true;
        }
      }

      // Recreate missing pool-init idle signals for fresh slots.
      // Signals can be lost on app restart or hook race conditions.
      if (
        slot.status === POOL_STATUS.FRESH &&
        slot.sessionId &&
        !fs.existsSync(path.join(IDLE_SIGNALS_DIR, String(slot.pid)))
      ) {
        createFreshIdleSignal(slot.pid, slot.sessionId);
      }
    }

    if (changed) writePool(pool);

    // Notify renderer about recovered slots
    if (recovered.length > 0 && _onPoolSlotsRecovered) {
      _onPoolSlotsRecovered(recovered);
    }

    // Prune session graph — remove entries for sessions that no longer exist
    pruneSessionGraph(pool);

    // Clean up orphaned processes: alive PIDs in session-pids that aren't
    // tracked by any pool slot or daemon PTY. Only kill processes confirmed
    // to be pool-origin (OPEN_COCKPIT_POOL=1 env var) — never external or
    // custom sessions.
    const knownPids = new Set(pool.slots.map((s) => String(s.pid)));
    for (const [, pty] of daemonPtys) {
      if (pty.pid) knownPids.add(String(pty.pid));
    }
    try {
      const pidFiles = fs.readdirSync(SESSION_PIDS_DIR);
      const orphanCandidates = [];
      for (const file of pidFiles) {
        if (knownPids.has(file)) continue;
        const pid = Number(file);
        if (!Number.isFinite(pid)) continue;
        if (!isPidAlive(pid)) {
          cleanupPidFiles(file);
          continue;
        }
        // Alive process not tracked by pool or daemon — candidate
        const sessionId = fs
          .readFileSync(path.join(SESSION_PIDS_DIR, file), "utf-8")
          .trim();
        if (!sessionId) continue;
        const meta = readOffloadMeta(sessionId);
        if (meta) continue; // Has offload data — managed session
        orphanCandidates.push({ file, pid, sessionId });
      }
      if (orphanCandidates.length > 0) {
        // Use proper origin detection (checks OPEN_COCKPIT_POOL env var
        // via ps eww / /proc) — only kill confirmed pool-origin processes.
        const { batchDetectOrigins } = getSessionDiscovery();
        const origins = await batchDetectOrigins(
          orphanCandidates.map((c) => c.pid),
        );
        for (const { file, pid, sessionId } of orphanCandidates) {
          const origin = origins.get(String(pid));
          if (origin !== "pool") continue; // Not a pool process — leave it alone
          _debugLog(
            "main",
            `Killing orphaned pool process PID ${pid} session=${sessionId} (origin=${origin}, not tracked by any pool slot)`,
          );
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* ESRCH */
          }
          cleanupPidFiles(file);
        }
      }
    } catch {
      /* ENOENT — no session-pids dir */
    }
  });

  // Restore missing sessions OUTSIDE the pool lock to avoid deadlock
  restoreFromActiveRegistry().catch((err) =>
    _debugLog("main", `Session restore after reconcile failed: ${err.message}`),
  );
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
            _debugLog(
              "main",
              `Failed to kill orphaned terminal ${pty.termId}: ${err.message}`,
            ),
          );
        }
      }
    })
    .catch((err) => {
      _debugLog("main", `killOrphanedTerminals failed: ${err.message}`);
    });
}

// Check if an idle session should be offloaded to maintain fresh slot availability.
// Returns offload target info, null (enough fresh slots), or false (pool not initialized).
// Acquires pool lock for the check.
// reserveSet: optional Set — if provided, excludes its members from candidates and
// atomically adds the found target (inside the lock) to prevent TOCTOU races.
async function checkOffloadNeeded(minFresh = 1, reserveSet) {
  const { getSessions } = getSessionDiscovery();
  return withPoolLock(async () => {
    const pool = readPool();
    if (!pool) return false;
    const sessions = await getSessions();
    enrichSessionsWithGraphData(sessions);
    const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));
    if (reserveSet) {
      for (const sid of reserveSet) sessionMap.delete(sid);
    }
    const target = findOffloadTarget(pool, sessionMap, minFresh);
    if (target && reserveSet) reserveSet.add(target.sessionId);
    return target;
  });
}

// Offload the given target (returned by checkOffloadNeeded).
async function executeOffload(target) {
  await offloadSession(target.sessionId, target.termId, null, {
    cwd: target.cwd,
    gitRoot: target.gitRoot,
    pid: target.pid,
  });
}

// Pre-warm the pool by offloading idle sessions to maintain minFreshSlots.
// Runs after reconcilePool on the same 30s interval.
async function preWarmPool() {
  const minFresh = getMinFreshSlots();
  if (minFresh === 0) return;

  // May need to offload multiple sessions to reach minFresh
  for (let i = 0; i < minFresh; i++) {
    let target;
    try {
      target = await checkOffloadNeeded(minFresh, _pendingOffloads);
    } catch (err) {
      // "No fresh or idle slots available" is expected — anything else is a bug
      if (!err.message?.includes("No fresh or idle")) {
        _debugLog("main", `Pre-warm check failed: ${err.message}`);
      }
      return; // checkOffloadNeeded only adds to _pendingOffloads on success
    }
    if (target === false) return; // Pool not initialized
    if (!target) return; // Enough fresh slots (nothing added to _pendingOffloads)
    _debugLog(
      "main",
      `Pre-warming pool: offloading session ${target.sessionId}`,
    );
    try {
      await executeOffload(target);
    } catch (err) {
      _debugLog("main", `Pre-warm offload failed: ${err.message}`);
      return;
    } finally {
      _pendingOffloads.delete(target.sessionId);
    }
  }
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
      _debugLog(
        "main",
        `Reaping orphaned terminal ${pty.termId} for ${meta.archived ? "archived" : "stale offloaded"} session ${pty.sessionId}`,
      );
      try {
        await daemonRequest({ type: "kill", termId: pty.termId });
      } catch (err) {
        _debugLog(
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

  // Never prune entries that are part of a parent-child relationship.
  // These must persist forever so children always appear under their parent.
  const parentIds = new Set();
  for (const entry of Object.values(graph)) {
    if (entry.parentSessionId) parentIds.add(entry.parentSessionId);
  }

  let pruned = false;
  for (const id of graphKeys) {
    if (knownIds.has(id)) continue;
    // Keep entries that are parents (have children pointing to them)
    if (parentIds.has(id)) continue;
    // Keep entries that are children (have a parentSessionId)
    if (graph[id].parentSessionId) continue;
    delete graph[id];
    pruned = true;
  }
  if (pruned) writeSessionGraph(graph);
}

// Sync pool.json slot statuses with live session state.
// Returns the (possibly updated) pool object, or null if no pool.
// Also updates the active-sessions registry so it survives crashes.
async function syncPoolStatuses(sessions) {
  return withPoolLock(() => {
    const pool = readPool();
    if (!pool) return null;
    const updated = syncStatuses(pool, sessions);
    if (updated) writePool(updated);
    const currentPool = updated || pool;
    try {
      syncRegistryWithPool(currentPool.slots);
    } catch (err) {
      _debugLog("main", `Failed to sync active registry: ${err.message}`);
    }
    return currentPool;
  });
}

// Remove idle-signal and session-pid files for a PID so it doesn't appear
// as a ghost session after process death.
function cleanupPidFiles(pidStr) {
  for (const dir of [IDLE_SIGNALS_DIR, SESSION_PIDS_DIR]) {
    try {
      fs.unlinkSync(path.join(dir, pidStr));
    } catch {}
  }
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

// Destroy pool: kill all slots and remove pool.json.
// The active-sessions registry persists across restarts so the next
// poolInit can automatically resume them via restoreFromActiveRegistry.
async function poolDestroy() {
  return withPoolLock(async () => {
    const pool = readPool();
    if (!pool) return;

    // Read the active-sessions registry to know which sessions should be
    // restored (skip archiving those).
    const registry = readActiveRegistry();
    const savedIds = new Set(Object.keys(registry));

    const { terminalHasInputCache, getOffloadedSessions } =
      getSessionDiscovery();
    for (const slot of pool.slots) {
      await killSlotProcess(slot);
      cleanupPidFiles(String(slot.pid));
    }

    // Kill orphan processes (sub-agents, stale slots) that have PID files
    // but weren't tracked as pool slots (slot loop already unlinked its own).
    try {
      for (const file of fs.readdirSync(SESSION_PIDS_DIR)) {
        const pid = Number(file);
        if (!Number.isFinite(pid)) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* ESRCH — already dead */
        }
        cleanupPidFiles(file);
      }
    } catch {
      /* SESSION_PIDS_DIR may not exist */
    }

    terminalHasInputCache.clear();
    try {
      fs.unlinkSync(POOL_FILE);
    } catch (err) {
      _debugLog(
        "main",
        "poolDestroy: failed to unlink pool.json:",
        err.message,
      );
    }
    // Archive non-archived offloaded sessions, except those pending restore
    for (const s of await getOffloadedSessions()) {
      if (s.status === STATUS.OFFLOADED && !savedIds.has(s.sessionId)) {
        await archiveSession(s.sessionId);
      }
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
function writeIntention(sessionId, content) {
  secureMkdirSync(INTENTIONS_DIR, { recursive: true });
  lastWrittenContent.set(sessionId, content);
  secureWriteFileSync(path.join(INTENTIONS_DIR, `${sessionId}.md`), content);
}

async function poolClean() {
  const { getSessions } = getSessionDiscovery();
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

// Ensure a fresh slot exists, then atomically claim and return it.
// The claimFn receives (pool, slot) inside the lock and should perform
// the slot-specific work (send prompt / resume command, mark busy, etc.).
// Returns whatever claimFn returns.
async function withFreshSlot(claimFn) {
  const { getSessions } = getSessionDiscovery();

  // Phase 1: check if offload is needed (inside lock).
  // _pendingOffloads prevents two concurrent callers from both deciding to
  // offload the same idle session (TOCTOU race).
  const needsOffload = await checkOffloadNeeded(1, _pendingOffloads);
  if (needsOffload === false) throw new Error("Pool not initialized");

  // Phase 2: offload outside lock (offloadSession acquires its own lock)
  if (needsOffload) {
    await executeOffload(needsOffload);
    await pollForSessionId(needsOffload.pid, 30000, needsOffload.sessionId);
  }

  // Phase 3: claim fresh slot atomically (inside lock — no gap for races)
  try {
    return await withPoolLock(async () => {
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
  } finally {
    if (needsOffload) _pendingOffloads.delete(needsOffload.sessionId);
  }
}

async function poolResume(sessionId) {
  const { invalidateSessionsCache } = getSessionDiscovery();
  validateSessionId(sessionId);

  // Prevent double-restore: guards against the race where concurrent
  // restoreFromActiveRegistry calls try to restore the same session before
  // trackNewSlot updates pool.json.
  if (_pendingRestores.has(sessionId)) {
    _debugLog(
      "main",
      `poolResume skipped: session ${sessionId} is already being restored`,
    );
    throw new Error("Session is already being restored");
  }

  // Check if this session is already live in a pool slot
  const currentPool = readPool();
  if (currentPool) {
    const alreadyLive = currentPool.slots.find(
      (s) => s.sessionId === sessionId,
    );
    if (alreadyLive) {
      _debugLog(
        "main",
        `poolResume skipped: session ${sessionId} already in slot ${alreadyLive.index} (termId=${alreadyLive.termId})`,
      );
      throw new Error("Session already live in pool");
    }
  }

  // The session ID is the Claude session ID — no offload metadata needed.
  // If offload meta exists with a different claudeSessionId, honor it (legacy).
  const meta = readOffloadMeta(sessionId);
  const claudeSessionId = meta?.claudeSessionId || sessionId;

  // Add guard after all validation — stays active until trackNewSlot resolves
  // (which happens async after poolResume returns).
  _pendingRestores.add(sessionId);

  let result;
  try {
    // Atomically ensure a fresh slot and claim it for /resume.
    // Unarchive only after the slot is claimed — if withFreshSlot fails,
    // the session stays archived instead of getting stuck in recents.
    result = await withFreshSlot(async (pool, slot) => {
      if (readOffloadMeta(sessionId)?.archived) unarchiveSession(sessionId);
      const oldSlotSessionId = slot.sessionId;

      _debugLog(
        "main",
        `poolResume: sending /resume ${claudeSessionId} to slot ${slot.index} (termId=${slot.termId} pid=${slot.pid})`,
      );

      try {
        await sendCommandToTerminal(slot.termId, `/resume ${claudeSessionId}`);
      } catch (err) {
        console.error("[main] /resume command failed:", err.message);
        throw err; // slot stays fresh (withFreshSlot default)
      }
      slot.status = POOL_STATUS.BUSY;
      slot.sessionId = null; // Clear so pollForResumedSession doesn't match the old slot session
      writePool(pool);

      // Track slot in background (session ID polling after /resume)
      trackNewSlot(
        { termId: slot.termId, pid: slot.pid },
        {
          excludeId: oldSlotSessionId,
          expectedStatus: POOL_STATUS.BUSY,
          skipTrustPrompt: true,
          skipFreshSignal: true,
          onError: () => _pendingRestores.delete(sessionId),
          onResolved: async (newSessionId) => {
            _pendingRestores.delete(sessionId);
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
                _debugLog(
                  "main",
                  `Failed to re-tag orphaned terminals: ${err.message}`,
                );
              }
              // /resume is a local command — no model processing happens, so
              // the Stop hook never fires. Create an idle signal immediately.
              // Use "resume" trigger (not in FRESH_TRIGGERS) so the session is
              // recognized as previously active → IDLE instead of fresh/typing.
              // Include real transcript path so transcriptContains can also
              // detect prior assistant messages as a secondary signal.
              const { findJsonlPath } = getSessionDiscovery();
              const transcriptPath = (await findJsonlPath(newSessionId)) || "";
              createFreshIdleSignal(slot.pid, newSessionId, {
                trigger: "resume",
                transcript: transcriptPath,
              });
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
  } catch (err) {
    _pendingRestores.delete(sessionId);
    throw err;
  }

  // Remove offload data outside the pool lock so fs.rmSync doesn't block
  // concurrent pool operations. Done after the slot is claimed and /resume sent.
  removeOffloadData(sessionId);
  invalidateSessionsCache();

  return result;
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
    if (_onIntentionChanged) {
      _onIntentionChanged(content);
    }
  });

  fileWatchers.set("current", file);
}

// Open the session's project directory in Cursor.
// Checks for .code-workspace files (matching project name or inside folder).
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

  // Check named workspace file
  const namedWorkspace = path.join(
    workspaceDir,
    `${projectName}.code-workspace`,
  );
  if (fs.existsSync(namedWorkspace)) {
    await platform.openInCursor(namedWorkspace);
    return;
  }

  // Check in-folder workspace file
  try {
    const entries = fs.readdirSync(cwd);
    const localWs = entries.find((e) => e.endsWith(".code-workspace"));
    if (localWs) {
      await platform.openInCursor(path.join(cwd, localWs));
      return;
    }
  } catch {
    /* ignore read errors */
  }

  // Fall back to opening the folder
  await platform.openInCursor(cwd);
}

// Run an AppleScript action on the iTerm session matching a PID's TTY.
// macOS-only — returns null on other platforms.
async function withITermSessionByPid(pid, action, resultValue) {
  const tty = await platform.getProcessTty(pid);
  return platform.withITermSessionByTty(tty, action, resultValue);
}

// Close the external terminal where a Claude session is running.
// Returns { closed: true, app } or { closed: false }.
async function closeExternalTerminal(pid) {
  if (!/^\d+$/.test(String(pid))) return { closed: false };

  const match = await withITermSessionByPid(pid, "close s", "closed");
  if (match) return { closed: true, ...match };

  // Fallback: kill the process (terminal app will close the tab on exit)
  try {
    process.kill(Number(pid), "SIGTERM");
    return { closed: true, app: "process" };
  } catch {
    return { closed: false };
  }
}

// Try to focus the external terminal (iTerm or Cursor) where a Claude session is running.
// Returns { focused: true, app } or { focused: false }.
async function focusExternalTerminal(pid) {
  if (!/^\d+$/.test(String(pid))) return { focused: false };

  const match = await withITermSessionByPid(
    pid,
    "select t\n          set index of w to 1\n          activate",
    "focused",
  );
  if (match) return { focused: true, ...match };

  // Try Cursor / VS Code: walk process tree to find terminal app ancestor
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

module.exports = {
  init,
  withPoolLock,
  poll,
  fileWatchers,
  readTerminalBuffer,
  stripAnsi,
  waitForBufferContent,
  sendCommandToTerminal,
  createFreshIdleSignal,
  offloadSession,
  validateSessionId,
  readSessionGraph,
  writeSessionGraph,
  recordSessionRelation,
  enrichSessionsWithGraphData,
  renderBufferToText,
  writeOffloadMeta,
  saveExternalClearOffload,
  archiveSession,
  unarchiveSession,
  removeOffloadData,
  readOffloadSnapshot,
  readOffloadMeta,
  resolveClaudePath,
  readPool,
  writePool,
  acceptTrustPrompt,
  getCachedClaudePath,
  spawnPoolSlot,
  poolInit,
  pollForSessionId,
  trackNewSlot,
  poolResize,
  getPoolHealth,
  cleanupStaleIdleSignals,
  reconcilePool,
  preWarmPool,
  getPoolTermIds,
  killOrphanedTerminals,
  reapOrphanedTerminals,
  pruneSessionGraph,
  syncPoolStatuses,
  killSlotProcess,
  poolDestroy,
  restoreFromActiveRegistry,
  validateTermId,
  readIntention,
  writeIntention,
  lastWrittenContent,
  poolClean,
  getPoolFlags,
  setPoolFlags,
  getMinFreshSlots,
  setMinFreshSlots,
  parseFlags,
  withFreshSlot,
  poolResume,
  watchIntention,
  openInCursor,
  focusExternalTerminal,
  closeExternalTerminal,
  setTerminalDims,
};
