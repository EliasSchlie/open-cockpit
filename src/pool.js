/**
 * Pool management logic — extracted for testability.
 * Pure functions that operate on pool data structures.
 */
const path = require("path");
const fs = require("fs");
const {
  STATUS,
  POOL_STATUS,
  INITIATOR,
  sessionToPoolStatus,
} = require("./session-statuses");
const { readJsonSync } = require("./secure-fs");

/**
 * Read pool.json from disk. Returns parsed object or null on failure.
 */
function readPool(poolFile) {
  return readJsonSync(poolFile);
}

/**
 * Write pool.json atomically (write to tmp, then rename).
 */
function writePool(poolFile, pool) {
  const { IS_WINDOWS } = require("./platform");
  fs.mkdirSync(path.dirname(poolFile), {
    recursive: true,
    ...(IS_WINDOWS ? {} : { mode: 0o700 }),
  });
  const tmp = poolFile + ".tmp";
  fs.writeFileSync(
    tmp,
    JSON.stringify(pool, null, 2),
    IS_WINDOWS ? {} : { mode: 0o600 },
  );
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
    status: POOL_STATUS.STARTING,
    sessionId: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Check if a slot is currently pinned (pinnedUntil in the future).
 */
function isSlotPinned(slot) {
  if (!slot.pinnedUntil) return false;
  return new Date(slot.pinnedUntil) > new Date();
}

/**
 * Check if a pool slot status represents an uncommitted session (fresh or typing).
 * Typing slots are "protected fresh" — user started typing but hasn't submitted yet.
 */
function isSlotUncommitted(status) {
  return status === POOL_STATUS.FRESH || status === POOL_STATUS.TYPING;
}

/**
 * Select candidates for shrinking: prefer fresh, then idle, then busy/starting.
 * Pinned slots are excluded from candidates.
 */
function selectShrinkCandidates(slots, count) {
  const priority = {
    [POOL_STATUS.FRESH]: 0,
    [POOL_STATUS.TYPING]: 1,
    [POOL_STATUS.IDLE]: 2,
    [POOL_STATUS.STARTING]: 3,
    [POOL_STATUS.BUSY]: 4,
    [POOL_STATUS.ERROR]: 5,
  };
  const candidates = [...slots]
    .filter((s) => !isSlotPinned(s))
    .sort((a, b) => {
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
      result.healthStatus = POOL_STATUS.DEAD;
      return result;
    }

    const session = slot.sessionId ? sessionMap.get(slot.sessionId) : null;
    if (!session) {
      result.healthStatus =
        slot.status === POOL_STATUS.STARTING || isSlotUncommitted(slot.status)
          ? POOL_STATUS.STARTING
          : "unknown";
      return result;
    }

    // Override "processing" for pool-fresh slots (Claude still initializing)
    if (
      slot.status === POOL_STATUS.FRESH &&
      session.status === STATUS.PROCESSING
    ) {
      result.healthStatus = POOL_STATUS.STARTING;
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
    if (slot.status === POOL_STATUS.STARTING) continue;
    const session = slot.sessionId ? sessionMap.get(slot.sessionId) : null;
    if (!session) continue;

    // Allow dead slots to recover if their process came back alive
    if (slot.status === POOL_STATUS.DEAD && !session.alive) continue;

    const newStatus = sessionToPoolStatus(session.status) ?? slot.status;

    if (newStatus !== slot.status) {
      slot.status = newStatus;
      changed = true;
    }
  }

  return changed ? pool : null;
}

/**
 * Find a pool slot by session ID. Validates format.
 * Returns { pool, slot } or throws.
 */
function findSlotBySessionId(pool, sessionId) {
  if (!pool) throw new Error("Pool not initialized");
  if (!/^[a-f0-9-]+$/i.test(sessionId))
    throw new Error("Invalid session ID format");
  const slot = pool.slots.find((s) => s.sessionId === sessionId);
  if (!slot) throw new Error(`No slot found for session ${sessionId}`);
  return { pool, slot };
}

/**
 * Find a pool slot by index. Validates type.
 * Returns { pool, slot } or throws.
 */
function findSlotByIndex(pool, slotIndex) {
  if (!pool) throw new Error("Pool not initialized");
  if (typeof slotIndex !== "number" || !Number.isFinite(slotIndex))
    throw new Error("slotIndex must be a number");
  const slot = pool.slots.find((s) => s.index === slotIndex);
  if (!slot) throw new Error(`No slot at index ${slotIndex}`);
  return { pool, slot };
}

/**
 * Resolve a slot from a message that has either sessionId or slotIndex.
 * slotIndex takes precedence when both are provided.
 * Returns { pool, slot } or throws.
 */
function resolveSlot(pool, msg) {
  if (msg.slotIndex !== undefined) return findSlotByIndex(pool, msg.slotIndex);
  if (msg.sessionId) return findSlotBySessionId(pool, msg.sessionId);
  throw new Error("sessionId or slotIndex required");
}

/**
 * Find an idle slot to offload so a fresh slot becomes available.
 * Returns offload info { sessionId, termId, pid, cwd, gitRoot } or null
 * if enough fresh slots already exist. Throws if no fresh or idle slots.
 * @param {number} [minFresh=1] — minimum number of fresh slots to maintain
 */
function findOffloadTarget(pool, sessionMap, minFresh = 1) {
  const freshCount = pool.slots.filter((s) => {
    // Typing slots don't count as fresh — they're protected
    if (s.status === POOL_STATUS.FRESH) return true;
    const session = s.sessionId ? sessionMap.get(s.sessionId) : null;
    return session && session.status === STATUS.FRESH;
  }).length;
  if (freshCount >= minFresh) return null;

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
    // Prefer offloading model-initiated sessions before user-initiated
    const ia = sa?.initiator === INITIATOR.MODEL ? 0 : 1;
    const ib = sb?.initiator === INITIATOR.MODEL ? 0 : 1;
    if (ia !== ib) return ia - ib;
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

module.exports = {
  readPool,
  writePool,
  createSlot,
  isSlotPinned,
  isSlotUncommitted,
  selectShrinkCandidates,
  computePoolHealth,
  syncStatuses,
  findSlotBySessionId,
  findSlotByIndex,
  resolveSlot,
  findOffloadTarget,
};
