/**
 * Pool management logic — extracted for testability.
 * Pure functions that operate on pool data structures.
 */
const path = require("path");
const fs = require("fs");

/**
 * Read pool.json from disk. Returns parsed object or null on failure.
 */
function readPool(poolFile) {
  try {
    return JSON.parse(fs.readFileSync(poolFile, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write pool.json atomically (write to tmp, then rename).
 */
function writePool(poolFile, pool) {
  fs.mkdirSync(path.dirname(poolFile), { recursive: true });
  const tmp = poolFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2));
  fs.renameSync(tmp, poolFile);
}

/**
 * Create a pool slot from a spawn result.
 */
function createSlot(index, termId, pid) {
  return {
    index,
    termId,
    pid,
    status: "starting",
    sessionId: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Select candidates for shrinking: prefer fresh, then idle, then busy/starting.
 */
function selectShrinkCandidates(slots, count) {
  const priority = { fresh: 0, idle: 1, starting: 2, busy: 3, error: 4 };
  const candidates = [...slots].sort((a, b) => {
    const pa = priority[a.status] ?? 5;
    const pb = priority[b.status] ?? 5;
    return pa - pb;
  });
  return candidates.slice(0, count);
}

/**
 * Compute pool health from pool data and live sessions.
 * Does NOT mutate the input pool — returns a new health object.
 */
function computePoolHealth(pool, sessions, isProcessAlive) {
  if (!pool) return { initialized: false, slots: [], counts: {} };

  const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));
  const slots = pool.slots.map((slot) => {
    const result = { ...slot };

    const alive = slot.pid ? isProcessAlive(slot.pid) : false;
    if (!alive) {
      result.healthStatus = "dead";
      return result;
    }

    const session = slot.sessionId ? sessionMap.get(slot.sessionId) : null;
    if (!session) {
      result.healthStatus =
        slot.status === "starting" || slot.status === "fresh"
          ? "starting"
          : "unknown";
      return result;
    }

    // Override "processing" for pool-fresh slots (Claude still initializing)
    if (slot.status === "fresh" && session.status === "processing") {
      result.healthStatus = "starting";
    } else {
      result.healthStatus = session.status;
    }
    result.intentionHeading = session.intentionHeading;
    result.cwd = session.cwd;
    return result;
  });

  const counts = {};
  for (const slot of slots) {
    const status = slot.healthStatus || slot.status;
    counts[status] = (counts[status] || 0) + 1;
  }

  return {
    initialized: true,
    poolSize: pool.poolSize,
    slots,
    counts,
  };
}

/**
 * Sync pool slot statuses with live session data.
 * Returns updated pool (or null if no changes).
 */
function syncStatuses(pool, sessions) {
  if (!pool) return null;

  const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));
  let changed = false;

  for (const slot of pool.slots) {
    if (slot.status === "dead" || slot.status === "starting") continue;
    const session = slot.sessionId ? sessionMap.get(slot.sessionId) : null;
    if (!session) continue;

    let newStatus = slot.status;
    if (session.status === "idle") newStatus = "idle";
    else if (session.status === "processing") newStatus = "busy";
    else if (session.status === "fresh") newStatus = "fresh";

    if (newStatus !== slot.status) {
      slot.status = newStatus;
      changed = true;
    }
  }

  return changed ? pool : null;
}

module.exports = {
  readPool,
  writePool,
  createSlot,
  selectShrinkCandidates,
  computePoolHealth,
  syncStatuses,
};
