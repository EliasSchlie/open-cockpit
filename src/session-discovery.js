const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  batchGetCwds: platformBatchGetCwds,
  batchGetProcessEnvs,
  readFileTail,
  findFileRecursive,
  isRootPath,
} = require("./platform");
const { sortSessions } = require("./sort-sessions");
const { parseOrigins, detectOrigin } = require("./parse-origins");
const {
  parseTerminalHasInput,
  checkTerminalInputs,
} = require("./terminal-input");
const { readPool: readPoolFile } = require("./pool");
const { STATUS, POOL_STATUS } = require("./session-statuses");
const { secureMkdirSync, secureWriteFileSync } = require("./secure-fs");
const { daemonRequest } = require("./daemon-client");
const {
  SESSION_PIDS_DIR,
  CLAUDE_PROJECTS_DIR,
  IDLE_SIGNALS_DIR,
  INTENTIONS_DIR,
  OFFLOADED_DIR,
  POOL_FILE,
  SESSION_GRAPH_FILE,
} = require("./paths");

// --- Init pattern for injected dependencies ---
let _debugLog = () => {};
let _onSessionsChanged = null;
function init({ debugLog, onSessionsChanged }) {
  if (debugLog) _debugLog = debugLog;
  _onSessionsChanged = onSessionsChanged;
}

// --- Inline helpers (copied from main.js, not worth a separate module) ---

function readIntention(sessionId) {
  const file = path.join(INTENTIONS_DIR, `${sessionId}.md`);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function readOffloadMeta(sessionId) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(OFFLOADED_DIR, sessionId, "meta.json"),
        "utf-8",
      ),
    );
  } catch {
    return null;
  }
}

function removeOffloadData(sessionId) {
  try {
    fs.rmSync(path.join(OFFLOADED_DIR, sessionId), { recursive: true });
  } catch {
    /* ENOENT */
  }
}

function readPool() {
  return readPoolFile(POOL_FILE);
}

// --- Module-level state ---

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

// Track stale sessions to detect transitions (stale -> not-stale)
const staleLoggedSessions = new Set();

// Track last-seen JSONL file sizes and when they last changed (sessionId -> { size, changedAt })
const jsonlSizeTracker = new Map();

// Terminal input detection via buffer parsing (true ground truth).
// Cached results refreshed by pollTerminalInput() every TERMINAL_POLL_MS.
const terminalHasInputCache = new Map(); // termId -> input text string
const TERMINAL_POLL_MS = 10_000;
const TERMINAL_WRITE_DEBOUNCE_MS = 500;

// Cache transcriptContains results (key -> true, once true stays true)
const transcriptCache = new Map();

// Sessions that have been through at least one processing cycle (non-pool-init).
// Once activated, a session should never fall back to fresh/typing classification.
const activatedSessions = new Set();

// Idle signal triggers that represent fresh/unactivated sessions.
// Signals with these triggers do NOT mark a session as activated.
const FRESH_TRIGGERS = new Set(["pool-init", "session-clear"]);

// In-flight promise to prevent concurrent getSessions() calls from spawning
// duplicate subprocesses. Second caller reuses the first's result.
let sessionsInFlight = null;

// Lightweight fingerprint: PID files + idle signal mtimes + offloaded dir.
// Avoids expensive subprocess calls when nothing changed.
let lastDirFingerprint = null;
let lastFullRefreshTs = 0;
const MAX_FINGERPRINT_AGE = 30000; // Force full refresh every 30s for liveness checks

// Poll fresh pool slots for terminal input by parsing their PTY buffers.
// Runs periodically to keep terminalHasInputCache in sync with ground truth.
// Uses `list` (returns all PTY buffers in one call) instead of per-slot
// `read-buffer` to work with any daemon version.
let pollInFlight = false;
let writeDebounceTimer = null;

// --- Functions ---

function freshOrTyping(hasIntentionContent, hasTermInput) {
  return hasIntentionContent || hasTermInput ? STATUS.TYPING : STATUS.FRESH;
}

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
      _debugLog("main", "pollTerminalInput: daemon unavailable", err.message);
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
      if (_onSessionsChanged) _onSessionsChanged();
    }
  } finally {
    pollInFlight = false;
  }
}

// Trigger a poll shortly after a keystroke is written to a fresh pool terminal.
// Debounced so rapid typing doesn't flood — only the trailing edge fires.
// Pool check is inside the callback to avoid disk I/O on every keystroke.
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
      _debugLog(
        "main",
        "pollTerminalInput (write-triggered) failed",
        err.message,
      ),
    );
  }, TERMINAL_WRITE_DEBOUNCE_MS);
}

// Detect session origin by reading process environment.
// macOS: ps eww, Linux: /proc/<pid>/environ, Windows: best-effort (defaults to "ext").
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
      const envData = await batchGetProcessEnvs(uncached);
      if (envData.format === "raw-ps") {
        // macOS: raw ps eww output for parseOrigins
        const parsed = parseOrigins(envData.raw, uncached);
        for (const [pid, origin] of parsed) {
          originCache.set(pid, origin);
          results.set(pid, origin);
        }
      } else if (envData.format === "per-pid") {
        // Linux: per-PID environ strings
        for (const pid of uncached) {
          const origin = detectOrigin(envData.byPid.get(pid) || "");
          originCache.set(pid, origin);
          results.set(pid, origin);
        }
      } else {
        // Windows/unavailable: default to ext
        for (const pid of uncached) {
          originCache.set(pid, "ext");
          results.set(pid, "ext");
        }
      }
    } catch (err) {
      console.error("[main] Failed to detect session origins:", err.message);
      for (const pid of uncached) {
        originCache.set(pid, "ext");
        results.set(pid, "ext");
      }
    }
  }
  return results;
}

async function findJsonlPath(sessionId) {
  if (jsonlPathCache.has(sessionId)) return jsonlPathCache.get(sessionId);
  try {
    const jsonlPath = await findFileRecursive(
      CLAUDE_PROJECTS_DIR,
      `${sessionId}.jsonl`,
    );
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

    const tail = await readFileTail(jsonlPath, 100);
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
    _debugLog("main", "getCwdFromJsonl failed for", sessionId, err.message);
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
          _debugLog(
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
      _debugLog(
        "main",
        "getOffloadedSessions: failed to read session",
        dir,
        err.message,
      );
    }
  }

  // Cascade: auto-archive offloaded children whose parent is archived.
  // Without this, sub-agent sessions offloaded before parent death linger in Recent.
  const hasOffloaded = sessions.some((s) => s.status === STATUS.OFFLOADED);
  if (hasOffloaded) {
    const archivedIds = new Set(
      sessions
        .filter((s) => s.status === STATUS.ARCHIVED)
        .map((s) => s.sessionId),
    );
    if (archivedIds.size > 0) {
      let sessionGraph;
      try {
        sessionGraph = JSON.parse(fs.readFileSync(SESSION_GRAPH_FILE, "utf-8"));
      } catch {
        sessionGraph = {};
      }
      for (const s of sessions) {
        if (s.status !== STATUS.OFFLOADED) continue;
        const entry = sessionGraph[s.sessionId];
        if (!entry?.parentSessionId) continue;
        if (!archivedIds.has(entry.parentSessionId)) continue;
        s.status = STATUS.ARCHIVED;
        // Persist so this doesn't recompute every time
        const meta = readOffloadMeta(s.sessionId);
        if (meta && !meta.archived) {
          meta.archived = true;
          meta.archivedAt = meta.archivedAt || new Date().toISOString();
          try {
            secureWriteFileSync(
              path.join(OFFLOADED_DIR, s.sessionId, "meta.json"),
              JSON.stringify(meta, null, 2),
            );
          } catch {
            /* best-effort */
          }
        }
      }
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

// Batch CWD detection: lsof on macOS, /proc on Linux, no-op on Windows
async function batchGetCwds(pids) {
  return platformBatchGetCwds(pids);
}

// Internal — not exported. Use getSessions() from other modules.
async function getSessionsUncached() {
  const sessions = [];
  const pool = readPool();
  // Pre-build session->slot map for O(1) lookups
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
    if (!cwd || cwd === os.homedir() || isRootPath(cwd)) {
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

      const staleTimeout =
        size != null && now - unchangedSince > STALE_PROCESSING_MS;

      // Pool sessions that were never used (no "user" entries) shouldn't be
      // marked stale — they're genuinely fresh, just missing their pool-init
      // idle signal (lost on app restart or hook race). Only mark stale if
      // the session has real user interaction or isn't a pool session.
      if (
        staleTimeout &&
        (!poolSlot ||
          (await transcriptContains(
            jsonlPathCache.get(sessionId),
            '"type":"user"',
          )))
      ) {
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
      _debugLog(
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
  // Child sessions (sub-agents) are NOT independently archived — they stay
  // grouped under their parent and only get archived when the parent is archived.
  const poolForArchive = readPool();
  const poolSessionIdsForArchive = new Set();
  if (poolForArchive) {
    for (const slot of poolForArchive.slots) {
      if (slot.sessionId) poolSessionIdsForArchive.add(slot.sessionId);
    }
  }
  let sessionGraph;
  try {
    sessionGraph = JSON.parse(fs.readFileSync(SESSION_GRAPH_FILE, "utf-8"));
  } catch {
    sessionGraph = {};
  }
  const sessionIdSet = new Set(sessions.map((s) => s.sessionId));
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.status !== STATUS.DEAD) continue;

    // Skip auto-archive for child sessions whose parent exists — they'll be
    // archived when the parent is archived (depth-first cascade in renderer)
    const graphEntry = sessionGraph[s.sessionId];
    if (
      graphEntry?.parentSessionId &&
      sessionIdSet.has(graphEntry.parentSessionId)
    ) {
      continue;
    }

    const offloadDir = path.join(OFFLOADED_DIR, s.sessionId);
    if (!fs.existsSync(offloadDir)) {
      // Skip archiving sessions that were never used (no intention = no user prompt)
      if (!s.intentionHeading) {
        try {
          fs.unlinkSync(path.join(SESSION_PIDS_DIR, String(s.pid)));
        } catch (err) {
          _debugLog(
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
      _debugLog("main", "failed to remove dead PID file", s.pid, err.message);
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

  // poolStatus is annotated by the get-sessions handler after syncPoolStatuses,
  // so it reflects the synced (not stale) pool state.

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

module.exports = {
  init,
  getSessions,
  invalidateSessionsCache,
  getOffloadedSessions,
  batchGetCwds,
  batchDetectOrigins,
  getIdleSignal,
  findJsonlPath,
  getCwdFromJsonl,
  getIntentionHeading,
  findGitRoot,
  pollTerminalInput,
  triggerPollOnWrite,
  terminalHasInputCache,
  getJsonlSize,
};
