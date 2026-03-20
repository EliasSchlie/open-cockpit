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
// terminal-input no longer needed — pool input detection via claude-pool's pendingInput
const { STATUS } = require("./session-statuses");
const {
  secureMkdirSync,
  secureWriteFileSync,
  readJsonSync,
} = require("./secure-fs");
const { daemonSendSafe } = require("./daemon-client");
const {
  SESSION_PIDS_DIR,
  CLAUDE_PROJECTS_DIR,
  IDLE_SIGNALS_DIR,
  INTENTIONS_DIR,
  OFFLOADED_DIR,
  SESSION_GRAPH_FILE,
  isPidAlive,
} = require("./paths");

// --- Init pattern for injected dependencies ---
let _debugLog = () => {};
let _onSessionsChanged = null;
let _claudePoolClient = null;
function init({ debugLog, onSessionsChanged, claudePoolClient }) {
  if (debugLog) _debugLog = debugLog;
  _onSessionsChanged = onSessionsChanged;
  if (claudePoolClient) _claudePoolClient = claudePoolClient;
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

async function getPoolSessions() {
  if (!_claudePoolClient || !_claudePoolClient.isConnected()) return null;
  try {
    const resp = await _claudePoolClient.ls({ verbosity: "flat" });
    return resp.sessions || [];
  } catch {
    return null;
  }
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

// Track consecutive empty-parse results per termId. A cached "has input" entry
// is only cleared after MISS_THRESHOLD consecutive polls return empty. This
// prevents transient parse failures (truncated buffer, mid-redraw, alt-screen
// loss) from dropping typing status.
const consecutiveMisses = new Map(); // termId -> miss count
const MISS_THRESHOLD = 3;

// Wrapper so external callers (pool-manager) keep consecutiveMisses in sync.
// Exposes Map-like interface used by pool-manager: .get(), .delete(), .clear(), .has()
const terminalInputApi = {
  get: (termId) => terminalHasInputCache.get(termId),
  has: (termId) => terminalHasInputCache.has(termId),
  set: (termId, val) => {
    consecutiveMisses.delete(termId);
    terminalHasInputCache.set(termId, val);
  },
  delete: (termId) => {
    consecutiveMisses.delete(termId);
    return terminalHasInputCache.delete(termId);
  },
  clear: () => {
    consecutiveMisses.clear();
    terminalHasInputCache.clear();
  },
};

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

// Force a clean TUI redraw by jittering the terminal width (cols+1 → cols).
// Claude Code's TUI redraws on SIGWINCH, flushing any mid-frame artifacts
// from the PTY buffer. A short delay lets the TUI finish writing its clean
// frame before the caller re-reads.
const JITTER_SETTLE_MS = 50;

async function jitterTerminal(termId, cols, rows) {
  daemonSendSafe({ type: "resize", termId, cols: cols + 1, rows });
  daemonSendSafe({ type: "resize", termId, cols, rows });
  await new Promise((r) => setTimeout(r, JITTER_SETTLE_MS));
}

// Track terminals that have received user keystrokes (via write API).
// When a write-triggered poll detects text, we trust it without jitter.
// Cleared when the terminal transitions out of fresh/typing.
const recentWriteTermIds = new Set();

async function pollTerminalInput() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    if (!_claudePoolClient || !_claudePoolClient.isConnected()) return;
    const resp = await _claudePoolClient.ls({ verbosity: "flat" });
    const sessions = resp.sessions || [];

    let changed = false;

    // Use pendingInput from claude-pool (go through terminalInputApi
    // to keep consecutiveMisses tracking in sync)
    for (const s of sessions) {
      const prev = terminalInputApi.get(s.sessionId) || "";
      if (s.pendingInput) {
        if (s.pendingInput !== prev) {
          terminalInputApi.set(s.sessionId, s.pendingInput);
          changed = true;
        }
      } else if (prev) {
        terminalInputApi.delete(s.sessionId);
        changed = true;
      }
    }

    if (changed) {
      invalidateSessionsCache();
      if (_onSessionsChanged) _onSessionsChanged();
    }
  } catch (err) {
    _debugLog("main", "pollTerminalInput failed", err.message);
  } finally {
    pollInFlight = false;
  }
}

// Trigger a poll shortly after a keystroke is written to a fresh pool terminal.
// Debounced so rapid typing doesn't flood — only the trailing edge fires.
function triggerPollOnWrite(termId) {
  recentWriteTermIds.add(termId);
  clearTimeout(writeDebounceTimer);
  writeDebounceTimer = setTimeout(() => {
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
  const graph = readJsonSync(SESSION_GRAPH_FILE, {});
  const parentIds = new Set(
    Object.values(graph)
      .map((e) => e.parentSessionId)
      .filter(Boolean),
  );
  const sessions = [];
  for (const dir of dirs) {
    try {
      const meta = readOffloadMeta(dir);
      if (!meta) continue;
      const snapshotFile = path.join(OFFLOADED_DIR, dir, "snapshot.log");
      const hasSnapshot = fs.existsSync(snapshotFile);
      // Preserve child sessions whose parent still exists (even without
      // snapshot/intention) so they stay grouped under their parent.
      const parentId = graph[dir]?.parentSessionId;
      const isChildWithParent =
        parentId && fs.existsSync(path.join(OFFLOADED_DIR, parentId));

      // Delete empty sessions (no snapshot + no intention) — they were never used.
      // But keep parent sessions that have children in the graph.
      if (
        !hasSnapshot &&
        !meta.intentionHeading &&
        !isChildWithParent &&
        !parentIds.has(dir)
      ) {
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
  // Get pool sessions from claude-pool (single call, reused for both
  // origin tagging and pool session injection later in this function).
  //
  // Pool internal IDs differ from Claude session UUIDs. We track both
  // pool IDs and pool PIDs so PID-discovered sessions can be correctly
  // tagged as pool origin.
  let poolSessionIds = new Set(); // pool internal IDs
  let poolPids = new Set(); // PIDs of pool session processes
  let poolSessionsFull = [];
  if (_claudePoolClient && _claudePoolClient.isConnected()) {
    try {
      const resp = await _claudePoolClient.ls({
        verbosity: "full",
        archived: true,
        parent: "none",
      });
      poolSessionsFull = resp.sessions || [];
      for (const s of poolSessionsFull) {
        poolSessionIds.add(s.sessionId);
        if (s.pid) poolPids.add(String(s.pid));
      }
    } catch {
      /* pool not running */
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

      const alive = isPidAlive(pid);

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
    const isPoolSession =
      poolSessionIds.has(sessionId) || poolPids.has(String(pid));
    // Only check intention content for pool sessions (avoids unnecessary file reads for external/idle)
    const intentionContent = isPoolSession
      ? readIntention(sessionId).trim()
      : "";
    const hasIntentionContent = !!intentionContent;
    const hasTermInput = !!(
      isPoolSession && terminalHasInputCache.get(sessionId)
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
        (!isPoolSession ||
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
        } else if (isPoolSession) {
          // Pool sessions always have idle signals when idle (pool-init,
          // stop, tool, permission, session-clear). syncPoolStatuses
          // recreates missing pool-init signals for fresh slots. So a
          // missing idle signal on a pool session means UserPromptSubmit
          // cleared it — the session is processing its first prompt.
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
        const termText = isPoolSession
          ? terminalHasInputCache.get(sessionId)
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

  // Archive dead sessions (save as archived without snapshot).
  // Child sessions are never independently auto-archived — archiveSession()
  // cascade-archives all descendants when the parent is archived.
  const sessionGraph = readJsonSync(SESSION_GRAPH_FILE, {});
  const graphParentIds = new Set(
    Object.values(sessionGraph)
      .map((e) => e.parentSessionId)
      .filter(Boolean),
  );
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.status !== STATUS.DEAD) continue;

    // Skip auto-archive for child sessions whose parent still exists — they'll
    // be cascade-archived when parent is archived via archiveSession().
    // If the parent is completely gone (no live session, no offload data), let
    // the child be auto-archived normally to prevent orphan accumulation.
    const graphEntry = sessionGraph[s.sessionId];
    if (graphEntry?.parentSessionId) {
      const parentLive = sessions.some(
        (p) => p.sessionId === graphEntry.parentSessionId,
      );
      const parentOffloaded =
        !parentLive &&
        fs.existsSync(path.join(OFFLOADED_DIR, graphEntry.parentSessionId));
      if (parentLive || parentOffloaded) continue;
    }

    const offloadDir = path.join(OFFLOADED_DIR, s.sessionId);
    if (!fs.existsSync(offloadDir)) {
      // Skip archiving sessions that were never used (no intention = no user prompt).
      // But keep parent sessions that have children in the graph — archive them instead.
      if (!s.intentionHeading && !graphParentIds.has(s.sessionId)) {
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
      const origin =
        poolSessionIds.has(s.sessionId) ||
        (s.pid && poolPids.has(String(s.pid)))
          ? "pool"
          : originCache.get(String(s.pid)) || "ext";

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

  // Add pool sessions from claude-pool that aren't already discovered via PID files.
  // This ensures pool sessions are visible even when hooks write to a different dir
  // (e.g., dev instances) or when PID files are missing.
  //
  // IMPORTANT: Pool internal IDs (e.g. "d1b65c90c75b") differ from Claude session
  // UUIDs (e.g. "8af44336-091f-...") written to PID files. Dedup by BOTH sessionId
  // AND PID to prevent the same session appearing twice.
  const discoveredIds = new Set(sessions.map((s) => s.sessionId));
  const discoveredPids = new Set(
    sessions.filter((s) => s.pid).map((s) => String(s.pid)),
  );
  {
    for (const ps of poolSessionsFull) {
      if (discoveredIds.has(ps.sessionId)) continue;
      // Skip if a PID-discovered session already covers this pool slot's process
      if (ps.pid && discoveredPids.has(String(ps.pid))) continue;
      // Map claude-pool status to OC status
      let status;
      switch (ps.status) {
        case "idle":
          status = STATUS.IDLE;
          break;
        case "processing":
          status = STATUS.PROCESSING;
          break;
        case "offloaded":
          status = STATUS.OFFLOADED;
          break;
        case "archived":
          status = STATUS.ARCHIVED;
          break;
        case "queued":
          status = STATUS.PROCESSING;
          break;
        case "error":
          status = STATUS.DEAD;
          break;
        default:
          status = STATUS.FRESH;
      }
      sessions.push({
        pid: ps.pid || null,
        sessionId: ps.sessionId,
        alive: !!ps.pid,
        cwd: ps.cwd || ps.spawnCwd || null,
        home: os.homedir(),
        gitRoot: null,
        project:
          ps.cwd || ps.spawnCwd ? path.basename(ps.cwd || ps.spawnCwd) : null,
        hasIntention: false,
        intentionHeading: null,
        status,
        idleTs: 0,
        staleIdle: false,
        origin: "pool",
      });
    }
  }

  // Tag sessions with origin: pool, sub-claude, or ext
  // Check both pool internal IDs and pool PIDs (since PID-discovered
  // sessions have Claude UUIDs, not pool IDs)
  const isPoolSession = (s) =>
    poolSessionIds.has(s.sessionId) || (s.pid && poolPids.has(String(s.pid)));
  const needOriginPids = sessions
    .filter((s) => s.alive && !isPoolSession(s))
    .map((s) => s.pid);
  const originMap = await batchDetectOrigins(needOriginPids);
  for (const s of sessions) {
    if (isPoolSession(s)) {
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
      // Don't store fingerprint if any live session has no idle signal and
      // was classified as fresh/typing. That's an ambiguous state (may be
      // processing but transcriptContains hasn't found the user entry yet).
      // Clearing the fingerprint forces re-evaluation on the next poll.
      const hasAmbiguous = result.some(
        (s) =>
          s.alive &&
          !s.idleTs &&
          (s.status === STATUS.FRESH || s.status === STATUS.TYPING),
      );
      lastDirFingerprint = hasAmbiguous ? null : computeDirFingerprint();
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
  jitterTerminal,
  terminalHasInputCache: terminalInputApi,
  getJsonlSize,
};
