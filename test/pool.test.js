import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  readPool,
  writePool,
  createSlot,
  isSlotPinned,
  selectShrinkCandidates,
  computePoolHealth,
  syncStatuses,
  findSlotBySessionId,
  findSlotByIndex,
  resolveSlot as resolveSlotByAddress,
  findOffloadTarget,
} from "../src/pool.js";

/** Inline helper — createPool was removed from pool.js (never called in production). */
function createPool(size) {
  return {
    version: 1,
    poolSize: size,
    createdAt: new Date().toISOString(),
    slots: [],
  };
}

/** Inline helper — resolveSlot was removed from pool.js (never called in production). */
function resolveSlot(pool, termId, sessionId) {
  const slot = pool.slots.find((s) => s.termId === termId);
  if (!slot) return false;
  slot.sessionId = sessionId;
  slot.status = sessionId ? "fresh" : "error";
  return true;
}

const TMP_DIR = path.join(os.tmpdir(), "open-cockpit-test-" + process.pid);
const POOL_FILE = path.join(TMP_DIR, "pool.json");

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("readPool / writePool", () => {
  it("returns null for missing file", () => {
    expect(readPool(POOL_FILE)).toBeNull();
  });

  it("returns null for corrupted JSON", () => {
    fs.writeFileSync(POOL_FILE, "not json{{{");
    expect(readPool(POOL_FILE)).toBeNull();
  });

  it("round-trips pool data atomically", () => {
    const pool = createPool(3);
    writePool(POOL_FILE, pool);
    const read = readPool(POOL_FILE);
    expect(read.version).toBe(1);
    expect(read.poolSize).toBe(3);
    expect(read.slots).toEqual([]);
    // Tmp file should not exist (rename is atomic)
    expect(fs.existsSync(POOL_FILE + ".tmp")).toBe(false);
  });
});

describe("createPool / createSlot", () => {
  it("creates a pool with correct structure", () => {
    const pool = createPool(5);
    expect(pool.version).toBe(1);
    expect(pool.poolSize).toBe(5);
    expect(pool.slots).toEqual([]);
    expect(pool.createdAt).toBeTruthy();
  });

  it("creates a slot in starting state", () => {
    const slot = createSlot(0, "term-abc", 12345);
    expect(slot.index).toBe(0);
    expect(slot.termId).toBe("term-abc");
    expect(slot.pid).toBe(12345);
    expect(slot.status).toBe("starting");
    expect(slot.sessionId).toBeNull();
  });
});

describe("resolveSlot", () => {
  it("updates slot with session ID on success", () => {
    const pool = createPool(1);
    pool.slots.push(createSlot(0, "t1", 100));
    const ok = resolveSlot(pool, "t1", "uuid-abc");
    expect(ok).toBe(true);
    expect(pool.slots[0].sessionId).toBe("uuid-abc");
    expect(pool.slots[0].status).toBe("fresh");
  });

  it("marks slot as error when no session ID", () => {
    const pool = createPool(1);
    pool.slots.push(createSlot(0, "t1", 100));
    resolveSlot(pool, "t1", null);
    expect(pool.slots[0].status).toBe("error");
    expect(pool.slots[0].sessionId).toBeNull();
  });

  it("returns false for unknown termId", () => {
    const pool = createPool(1);
    pool.slots.push(createSlot(0, "t1", 100));
    expect(resolveSlot(pool, "t-unknown", "uuid")).toBe(false);
  });
});

describe("selectShrinkCandidates", () => {
  it("prefers fresh slots over idle ones", () => {
    const slots = [
      { index: 0, status: "idle" },
      { index: 1, status: "fresh" },
      { index: 2, status: "processing" },
      { index: 3, status: "fresh" },
    ];
    const result = selectShrinkCandidates(slots, 2);
    expect(result.map((s) => s.index)).toEqual([1, 3]);
  });

  it("falls back to busy slots when no fresh/idle available", () => {
    const slots = [
      { index: 0, status: "busy" },
      { index: 1, status: "busy" },
      { index: 2, status: "idle" },
    ];
    const result = selectShrinkCandidates(slots, 2);
    expect(result.map((s) => s.index)).toEqual([2, 0]);
  });

  it("includes busy slots when all are busy", () => {
    const slots = [
      { index: 0, status: "busy" },
      { index: 1, status: "busy" },
    ];
    const result = selectShrinkCandidates(slots, 1);
    expect(result).toHaveLength(1);
  });
});

describe("computePoolHealth", () => {
  it("returns uninitialized when pool is null", () => {
    const health = computePoolHealth(null, [], () => false);
    expect(health.initialized).toBe(false);
  });

  it("marks dead slots when process is not alive", () => {
    const pool = createPool(1);
    pool.slots.push({ ...createSlot(0, "t1", 100), sessionId: "s1" });
    const health = computePoolHealth(pool, [], () => false);
    expect(health.slots[0].healthStatus).toBe("dead");
    expect(health.counts.dead).toBe(1);
  });

  it("shows starting for pool-fresh slots without live session", () => {
    const pool = createPool(1);
    const slot = createSlot(0, "t1", 100);
    slot.status = "fresh";
    slot.sessionId = "s1";
    pool.slots.push(slot);
    // Process alive but no session found yet
    const health = computePoolHealth(pool, [], () => true);
    expect(health.slots[0].healthStatus).toBe("starting");
  });

  it("overrides processing with starting for fresh pool slots", () => {
    const pool = createPool(1);
    const slot = createSlot(0, "t1", 100);
    slot.status = "fresh";
    slot.sessionId = "s1";
    pool.slots.push(slot);
    // Session exists but shows as processing (no idle signal yet)
    const sessions = [{ sessionId: "s1", status: "processing" }];
    const health = computePoolHealth(pool, sessions, () => true);
    expect(health.slots[0].healthStatus).toBe("starting");
  });

  it("shows idle when session is idle", () => {
    const pool = createPool(1);
    const slot = createSlot(0, "t1", 100);
    slot.status = "idle";
    slot.sessionId = "s1";
    pool.slots.push(slot);
    const sessions = [
      {
        sessionId: "s1",
        status: "idle",
        intentionHeading: "Test",
        cwd: "/tmp",
      },
    ];
    const health = computePoolHealth(pool, sessions, () => true);
    expect(health.slots[0].healthStatus).toBe("idle");
    expect(health.slots[0].intentionHeading).toBe("Test");
    expect(health.counts.idle).toBe(1);
  });

  it("counts multiple statuses correctly", () => {
    const pool = createPool(3);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
      { ...createSlot(2, "t3", 300), status: "fresh", sessionId: "s3" },
    );
    const sessions = [
      { sessionId: "s1", status: "idle" },
      { sessionId: "s2", status: "processing" },
      { sessionId: "s3", status: "fresh" },
    ];
    const health = computePoolHealth(pool, sessions, () => true);
    expect(health.counts.idle).toBe(1);
    expect(health.counts.processing).toBe(1);
    expect(health.counts.fresh).toBe(1);
  });

  it("does not mutate the input pool object", () => {
    const pool = createPool(1);
    pool.slots.push({ ...createSlot(0, "t1", 100), sessionId: "s1" });
    const originalSlot = { ...pool.slots[0] };
    computePoolHealth(pool, [], () => true);
    // Original pool should not have healthStatus added
    expect(pool.slots[0]).toEqual(originalSlot);
  });
});

describe("syncStatuses", () => {
  it("returns null when nothing changed", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "idle",
      sessionId: "s1",
    });
    const sessions = [{ sessionId: "s1", status: "idle" }];
    expect(syncStatuses(pool, sessions)).toBeNull();
  });

  it("updates slot from fresh to idle when session becomes idle", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "fresh",
      sessionId: "s1",
    });
    const sessions = [{ sessionId: "s1", status: "idle" }];
    const updated = syncStatuses(pool, sessions);
    expect(updated).not.toBeNull();
    expect(updated.slots[0].status).toBe("idle");
  });

  it("updates slot to busy when session is processing", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "idle",
      sessionId: "s1",
    });
    const sessions = [{ sessionId: "s1", status: "processing" }];
    const updated = syncStatuses(pool, sessions);
    expect(updated.slots[0].status).toBe("busy");
  });

  it("skips dead and starting slots", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "dead", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "starting", sessionId: null },
    );
    const sessions = [{ sessionId: "s1", status: "idle" }];
    expect(syncStatuses(pool, sessions)).toBeNull();
  });

  it("returns null for null pool", () => {
    expect(syncStatuses(null, [])).toBeNull();
  });
});

describe("pool lifecycle integration", () => {
  it("full init → resolve → sync → health cycle", () => {
    // 1. Create pool
    const pool = createPool(3);

    // 2. Add slots (simulating daemon spawns)
    pool.slots.push(createSlot(0, "t1", 100));
    pool.slots.push(createSlot(1, "t2", 200));
    pool.slots.push(createSlot(2, "t3", 300));
    expect(pool.slots.every((s) => s.status === "starting")).toBe(true);

    // 3. Resolve slots (simulating pollForSessionId success)
    resolveSlot(pool, "t1", "uuid-1");
    resolveSlot(pool, "t2", "uuid-2");
    resolveSlot(pool, "t3", null); // failed to get session ID
    expect(pool.slots[0].status).toBe("fresh");
    expect(pool.slots[1].status).toBe("fresh");
    expect(pool.slots[2].status).toBe("error");

    // 4. Persist and re-read
    writePool(POOL_FILE, pool);
    const reloaded = readPool(POOL_FILE);
    expect(reloaded.slots[0].sessionId).toBe("uuid-1");

    // 5. Health check — sessions not yet discovered (Claude starting up)
    const health1 = computePoolHealth(
      reloaded,
      [],
      (pid) => pid !== 300, // slot 2 died
    );
    expect(health1.slots[0].healthStatus).toBe("starting"); // fresh + no session
    expect(health1.slots[1].healthStatus).toBe("starting");
    expect(health1.slots[2].healthStatus).toBe("dead"); // PID 300 not alive

    // 6. Sessions discovered but no idle signals (shows as processing)
    const sessions = [
      { sessionId: "uuid-1", status: "processing" },
      { sessionId: "uuid-2", status: "processing" },
    ];
    const health2 = computePoolHealth(reloaded, sessions, () => true);
    expect(health2.slots[0].healthStatus).toBe("starting"); // fresh + processing = starting
    expect(health2.slots[1].healthStatus).toBe("starting");

    // 7. Stop hooks fire → sessions become fresh
    sessions[0].status = "fresh";
    sessions[1].status = "fresh";
    const health3 = computePoolHealth(reloaded, sessions, () => true);
    expect(health3.slots[0].healthStatus).toBe("fresh");
    expect(health3.counts.fresh).toBe(2);

    // 8. User starts using a session → becomes idle
    sessions[0].status = "idle";
    const synced = syncStatuses(reloaded, sessions);
    expect(synced).not.toBeNull();
    expect(synced.slots[0].status).toBe("idle");
    expect(synced.slots[1].status).toBe("fresh");
  });

  it("shrink selects correct candidates", () => {
    const pool = createPool(4);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "fresh", sessionId: "s2" },
      { ...createSlot(2, "t3", 300), status: "busy", sessionId: "s3" },
      { ...createSlot(3, "t4", 400), status: "fresh", sessionId: "s4" },
    );

    // Shrink by 2: should pick fresh slots first (indices 1, 3)
    const victims = selectShrinkCandidates(pool.slots, 2);
    expect(victims.map((v) => v.index)).toEqual([1, 3]);

    // Shrink by 3: 2 fresh + 1 idle + 0 busy (but only 3 needed)
    const victims2 = selectShrinkCandidates(pool.slots, 3);
    expect(victims2.map((v) => v.index)).toEqual([1, 3, 0]);

    // Shrink by 4: includes busy slot too
    const victims3 = selectShrinkCandidates(pool.slots, 4);
    expect(victims3.map((v) => v.index)).toEqual([1, 3, 0, 2]);
  });

  it("offload → fresh cycle updates pool state", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "old-uuid" },
      { ...createSlot(1, "t2", 200), status: "busy", sessionId: "s2" },
    );

    // Simulate offload: mark slot as fresh, clear session ID
    const slot = pool.slots[0];
    slot.status = "fresh";
    slot.sessionId = null;
    expect(pool.slots[0].status).toBe("fresh");
    expect(pool.slots[0].sessionId).toBeNull();

    // Simulate new session ID after /clear
    resolveSlot(pool, "t1", "new-uuid");
    expect(pool.slots[0].sessionId).toBe("new-uuid");
    expect(pool.slots[0].status).toBe("fresh");
  });
});

describe("findSlotBySessionId", () => {
  it("finds a slot by session ID", () => {
    const pool = createPool(2);
    pool.slots = [createSlot(0, 10, 100), createSlot(1, 11, 101)];
    pool.slots[0].sessionId = "abc-123";
    pool.slots[1].sessionId = "def-456";

    const { slot } = findSlotBySessionId(pool, "def-456");
    expect(slot.index).toBe(1);
    expect(slot.termId).toBe(11);
  });

  it("throws for invalid session ID format", () => {
    const pool = createPool(1);
    expect(() => findSlotBySessionId(pool, "not valid!")).toThrow(
      "Invalid session ID format",
    );
  });

  it("throws when session ID not found", () => {
    const pool = createPool(1);
    pool.slots = [createSlot(0, 10, 100)];
    pool.slots[0].sessionId = "abc-123";

    expect(() => findSlotBySessionId(pool, "def-999")).toThrow(
      "No slot found for session def-999",
    );
  });

  it("throws when pool is null", () => {
    expect(() => findSlotBySessionId(null, "abc-123")).toThrow(
      "Pool not initialized",
    );
  });
});

describe("findSlotByIndex", () => {
  it("finds a slot by index", () => {
    const pool = createPool(3);
    pool.slots = [
      createSlot(0, 10, 100),
      createSlot(1, 11, 101),
      createSlot(2, 12, 102),
    ];

    const { slot } = findSlotByIndex(pool, 2);
    expect(slot.termId).toBe(12);
    expect(slot.pid).toBe(102);
  });

  it("finds slot at index 0", () => {
    const pool = createPool(2);
    pool.slots = [createSlot(0, 10, 100), createSlot(1, 11, 101)];

    const { slot } = findSlotByIndex(pool, 0);
    expect(slot.index).toBe(0);
    expect(slot.termId).toBe(10);
  });

  it("throws for non-number slotIndex", () => {
    const pool = createPool(1);
    pool.slots = [createSlot(0, 10, 100)];

    expect(() => findSlotByIndex(pool, "0")).toThrow(
      "slotIndex must be a number",
    );
    expect(() => findSlotByIndex(pool, null)).toThrow(
      "slotIndex must be a number",
    );
    expect(() => findSlotByIndex(pool, NaN)).toThrow(
      "slotIndex must be a number",
    );
    expect(() => findSlotByIndex(pool, Infinity)).toThrow(
      "slotIndex must be a number",
    );
  });

  it("throws when index not found", () => {
    const pool = createPool(2);
    pool.slots = [createSlot(0, 10, 100)];

    expect(() => findSlotByIndex(pool, 5)).toThrow("No slot at index 5");
  });

  it("throws when pool is null", () => {
    expect(() => findSlotByIndex(null, 0)).toThrow("Pool not initialized");
  });
});

describe("resolveSlotByAddress", () => {
  const pool = createPool(2);
  pool.slots = [createSlot(0, 10, 100), createSlot(1, 11, 101)];
  pool.slots[0].sessionId = "abc-123";
  pool.slots[1].sessionId = "def-456";

  it("resolves by slotIndex", () => {
    const { slot } = resolveSlotByAddress(pool, { slotIndex: 1 });
    expect(slot.sessionId).toBe("def-456");
  });

  it("resolves by sessionId", () => {
    const { slot } = resolveSlotByAddress(pool, { sessionId: "abc-123" });
    expect(slot.index).toBe(0);
  });

  it("prefers slotIndex when both provided", () => {
    const { slot } = resolveSlotByAddress(pool, {
      slotIndex: 1,
      sessionId: "abc-123",
    });
    expect(slot.index).toBe(1);
  });

  it("handles slotIndex 0 (falsy but valid)", () => {
    const { slot } = resolveSlotByAddress(pool, { slotIndex: 0 });
    expect(slot.index).toBe(0);
    expect(slot.sessionId).toBe("abc-123");
  });

  it("prefers slotIndex 0 over sessionId", () => {
    const { slot } = resolveSlotByAddress(pool, {
      slotIndex: 0,
      sessionId: "def-456",
    });
    expect(slot.index).toBe(0);
    expect(slot.sessionId).toBe("abc-123");
  });

  it("throws when neither provided", () => {
    expect(() => resolveSlotByAddress(pool, {})).toThrow(
      "sessionId or slotIndex required",
    );
  });

  it("works on error slots with null sessionId", () => {
    const errorPool = createPool(1);
    errorPool.slots = [createSlot(0, 10, 100)];
    errorPool.slots[0].status = "error";
    // sessionId is null (default from createSlot)

    const { slot } = resolveSlotByAddress(errorPool, { slotIndex: 0 });
    expect(slot.status).toBe("error");
    expect(slot.sessionId).toBeNull();
  });
});

describe("isSlotPinned", () => {
  it("returns false when no pinnedUntil", () => {
    expect(isSlotPinned({ status: "idle" })).toBe(false);
  });

  it("returns false when pinnedUntil is null", () => {
    expect(isSlotPinned({ status: "idle", pinnedUntil: null })).toBe(false);
  });

  it("returns true when pinnedUntil is in the future", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    expect(isSlotPinned({ status: "idle", pinnedUntil: future })).toBe(true);
  });

  it("returns false when pinnedUntil is in the past", () => {
    const past = new Date(Date.now() - 60000).toISOString();
    expect(isSlotPinned({ status: "idle", pinnedUntil: past })).toBe(false);
  });
});

describe("selectShrinkCandidates with pinning", () => {
  it("excludes pinned slots from candidates", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const slots = [
      { index: 0, status: "idle" },
      { index: 1, status: "fresh" },
      { index: 2, status: "idle", pinnedUntil: future },
      { index: 3, status: "fresh" },
    ];
    const result = selectShrinkCandidates(slots, 3);
    expect(result.map((s) => s.index)).toEqual([1, 3, 0]);
    expect(result.every((s) => s.index !== 2)).toBe(true);
  });

  it("includes expired pins as candidates", () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const slots = [
      { index: 0, status: "idle", pinnedUntil: past },
      { index: 1, status: "fresh" },
    ];
    const result = selectShrinkCandidates(slots, 2);
    expect(result.map((s) => s.index)).toEqual([1, 0]);
  });

  it("returns empty when all slots are pinned", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const slots = [
      { index: 0, status: "idle", pinnedUntil: future },
      { index: 1, status: "fresh", pinnedUntil: future },
    ];
    const result = selectShrinkCandidates(slots, 2);
    expect(result).toHaveLength(0);
  });
});

describe("syncStatuses — dead slot recovery (#107)", () => {
  it.each([
    { sessionStatus: "idle", expectedSlot: "idle" },
    { sessionStatus: "processing", expectedSlot: "busy" },
    { sessionStatus: "fresh", expectedSlot: "fresh" },
  ])(
    "recovers dead slot to $expectedSlot when session is $sessionStatus and alive",
    ({ sessionStatus, expectedSlot }) => {
      const pool = createPool(1);
      pool.slots.push({
        ...createSlot(0, "t1", 100),
        status: "dead",
        sessionId: "s1",
      });
      const sessions = [
        { sessionId: "s1", status: sessionStatus, alive: true },
      ];
      const updated = syncStatuses(pool, sessions);
      expect(updated).not.toBeNull();
      expect(updated.slots[0].status).toBe(expectedSlot);
    },
  );

  it("keeps dead slot dead when session is not alive", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "dead",
      sessionId: "s1",
    });
    const sessions = [{ sessionId: "s1", status: "idle", alive: false }];
    expect(syncStatuses(pool, sessions)).toBeNull();
  });

  it("keeps dead slot dead when session has no alive field", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "dead",
      sessionId: "s1",
    });
    // alive is undefined (falsy)
    const sessions = [{ sessionId: "s1", status: "idle" }];
    expect(syncStatuses(pool, sessions)).toBeNull();
  });

  it("skips dead slots with no matching session", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "dead",
      sessionId: "s1",
    });
    const sessions = [{ sessionId: "other", status: "idle", alive: true }];
    expect(syncStatuses(pool, sessions)).toBeNull();
  });
});

describe("computePoolHealth — edge cases", () => {
  it.each([
    { slotStatus: "idle", expected: "unknown" },
    { slotStatus: "busy", expected: "unknown" },
  ])(
    "marks slot as $expected when alive, no session, and status is $slotStatus",
    ({ slotStatus, expected }) => {
      const pool = createPool(1);
      pool.slots.push({
        ...createSlot(0, "t1", 100),
        status: slotStatus,
        sessionId: "s1",
      });
      const health = computePoolHealth(pool, [], () => true);
      expect(health.slots[0].healthStatus).toBe(expected);
    },
  );

  it("marks slot as starting when alive, no session, and status is starting", () => {
    const pool = createPool(1);
    pool.slots.push(createSlot(0, "t1", 100));
    const health = computePoolHealth(pool, [], () => true);
    expect(health.slots[0].healthStatus).toBe("starting");
  });

  it.each([null, 0])("marks dead when pid is %s (falsy)", (pid) => {
    const pool = createPool(1);
    pool.slots.push({ ...createSlot(0, "t1", pid), sessionId: "s1" });
    const health = computePoolHealth(pool, [], () => true);
    expect(health.slots[0].healthStatus).toBe("dead");
  });

  it("returns poolSize in health output", () => {
    const pool = createPool(5);
    pool.slots = [];
    const health = computePoolHealth(pool, [], () => true);
    expect(health.poolSize).toBe(5);
    expect(health.initialized).toBe(true);
    expect(health.slots).toEqual([]);
  });

  it("handles empty slots array", () => {
    const pool = createPool(0);
    const health = computePoolHealth(pool, [], () => true);
    expect(health.initialized).toBe(true);
    expect(health.slots).toEqual([]);
    expect(health.counts).toEqual({});
  });

  it("propagates cwd from session to health slot", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "idle",
      sessionId: "s1",
    });
    const sessions = [{ sessionId: "s1", status: "idle", cwd: "/home/user" }];
    const health = computePoolHealth(pool, sessions, () => true);
    expect(health.slots[0].cwd).toBe("/home/user");
  });
});

describe("findOffloadTarget", () => {
  it("returns null when a fresh slot exists by slot status", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "fresh", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
    );
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "idle" }],
      ["s2", { sessionId: "s2", status: "idle" }],
    ]);
    expect(findOffloadTarget(pool, sessionMap)).toBeNull();
  });

  it("returns null when a fresh slot exists by session status", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "busy", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
    );
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "fresh" }],
      ["s2", { sessionId: "s2", status: "idle" }],
    ]);
    expect(findOffloadTarget(pool, sessionMap)).toBeNull();
  });

  it("picks the LRU idle slot when no fresh slot exists", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
    );
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "idle", idleTs: 200 }],
      ["s2", { sessionId: "s2", status: "idle", idleTs: 100 }],
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.sessionId).toBe("s2"); // s2 has earlier idleTs (LRU)
    expect(target.termId).toBe("t2");
    expect(target.pid).toBe(200);
  });

  it("includes cwd and gitRoot from session", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "idle",
      sessionId: "s1",
    });
    const sessionMap = new Map([
      [
        "s1",
        {
          sessionId: "s1",
          status: "idle",
          idleTs: 50,
          cwd: "/proj",
          gitRoot: "/proj",
        },
      ],
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.cwd).toBe("/proj");
    expect(target.gitRoot).toBe("/proj");
  });

  it("throws when no fresh or idle slots available", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "busy", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "busy", sessionId: "s2" },
    );
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "processing" }],
      ["s2", { sessionId: "s2", status: "processing" }],
    ]);
    expect(() => findOffloadTarget(pool, sessionMap)).toThrow(
      "No fresh or idle slots available",
    );
  });

  it("skips pinned idle slots", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const pool = createPool(2);
    pool.slots.push(
      {
        ...createSlot(0, "t1", 100),
        status: "idle",
        sessionId: "s1",
        pinnedUntil: future,
      },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
    );
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "idle", idleTs: 50 }],
      ["s2", { sessionId: "s2", status: "idle", idleTs: 100 }],
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.sessionId).toBe("s2"); // s1 is pinned
  });

  it("throws when all idle slots are pinned", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "idle",
      sessionId: "s1",
      pinnedUntil: future,
    });
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "idle", idleTs: 50 }],
    ]);
    expect(() => findOffloadTarget(pool, sessionMap)).toThrow(
      "No fresh or idle slots available",
    );
  });

  it("treats slots with no session data as non-idle", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      {
        ...createSlot(1, "t2", 200),
        status: "idle",
        sessionId: "s2",
      },
    );
    // s2 not in sessionMap — its session data is missing
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "idle", idleTs: 100 }],
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.sessionId).toBe("s1"); // only s1 has session data
  });

  it("uses idleTs 0 as default when session has no idleTs", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
    );
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "idle", idleTs: 500 }],
      ["s2", { sessionId: "s2", status: "idle" }], // no idleTs
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.sessionId).toBe("s2"); // idleTs defaults to 0 (oldest)
  });

  it("offloads model-initiated sessions before user-initiated", () => {
    const pool = createPool(3);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
      { ...createSlot(2, "t3", 300), status: "idle", sessionId: "s3" },
    );
    const sessionMap = new Map([
      [
        "s1",
        { sessionId: "s1", status: "idle", idleTs: 100, initiator: "user" },
      ],
      [
        "s2",
        { sessionId: "s2", status: "idle", idleTs: 200, initiator: "model" },
      ],
      [
        "s3",
        { sessionId: "s3", status: "idle", idleTs: 50, initiator: "user" },
      ],
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.sessionId).toBe("s2"); // model-initiated offloaded first
  });

  it("uses LRU within same initiator group", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
    );
    const sessionMap = new Map([
      [
        "s1",
        { sessionId: "s1", status: "idle", idleTs: 300, initiator: "model" },
      ],
      [
        "s2",
        { sessionId: "s2", status: "idle", idleTs: 100, initiator: "model" },
      ],
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.sessionId).toBe("s2"); // s2 has earlier idleTs (LRU)
  });

  it("treats missing initiator as user-initiated", () => {
    const pool = createPool(2);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "idle", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
    );
    const sessionMap = new Map([
      ["s1", { sessionId: "s1", status: "idle", idleTs: 100 }], // no initiator
      [
        "s2",
        { sessionId: "s2", status: "idle", idleTs: 200, initiator: "model" },
      ],
    ]);
    const target = findOffloadTarget(pool, sessionMap);
    expect(target.sessionId).toBe("s2"); // model offloaded before implicit user
  });
});

describe("readPool / writePool — edge cases", () => {
  it("creates parent directory if it does not exist", () => {
    const nestedFile = path.join(TMP_DIR, "nested", "deep", "pool.json");
    const pool = createPool(1);
    writePool(nestedFile, pool);
    expect(readPool(nestedFile)).toEqual(pool);
  });

  it("overwrites existing file", () => {
    const pool1 = createPool(1);
    writePool(POOL_FILE, pool1);
    const pool2 = createPool(5);
    writePool(POOL_FILE, pool2);
    expect(readPool(POOL_FILE).poolSize).toBe(5);
  });

  it("returns null for empty file", () => {
    fs.writeFileSync(POOL_FILE, "");
    expect(readPool(POOL_FILE)).toBeNull();
  });
});

describe("session lifecycle transitions", () => {
  it("fresh → idle → offload → fresh cycle via syncStatuses", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "fresh",
      sessionId: "s1",
    });

    // fresh → idle
    let updated = syncStatuses(pool, [{ sessionId: "s1", status: "idle" }]);
    expect(updated.slots[0].status).toBe("idle");

    // Simulate offload: reset slot to starting
    pool.slots[0].status = "starting";
    pool.slots[0].sessionId = null;

    // After /clear resolves: new session fresh
    pool.slots[0].status = "fresh";
    pool.slots[0].sessionId = "s2";

    updated = syncStatuses(pool, [{ sessionId: "s2", status: "fresh" }]);
    // fresh → fresh = no change
    expect(updated).toBeNull();
    expect(pool.slots[0].status).toBe("fresh");
  });

  it("fresh → busy → idle → dead lifecycle", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "fresh",
      sessionId: "s1",
    });

    // fresh → busy (user starts work)
    let updated = syncStatuses(pool, [
      { sessionId: "s1", status: "processing" },
    ]);
    expect(updated.slots[0].status).toBe("busy");

    // busy → idle (processing complete)
    updated = syncStatuses(pool, [{ sessionId: "s1", status: "idle" }]);
    expect(updated.slots[0].status).toBe("idle");

    // Simulate death: mark slot dead
    pool.slots[0].status = "dead";
    // Dead slot with dead session stays dead
    updated = syncStatuses(pool, [
      { sessionId: "s1", status: "idle", alive: false },
    ]);
    expect(updated).toBeNull();
    expect(pool.slots[0].status).toBe("dead");
  });

  it("dead → recovery → idle lifecycle", () => {
    const pool = createPool(1);
    pool.slots.push({
      ...createSlot(0, "t1", 100),
      status: "dead",
      sessionId: "s1",
    });

    // Process comes back alive
    const updated = syncStatuses(pool, [
      { sessionId: "s1", status: "idle", alive: true },
    ]);
    expect(updated).not.toBeNull();
    expect(updated.slots[0].status).toBe("idle");
  });

  it("multi-slot mixed transitions", () => {
    const pool = createPool(3);
    pool.slots.push(
      { ...createSlot(0, "t1", 100), status: "fresh", sessionId: "s1" },
      { ...createSlot(1, "t2", 200), status: "idle", sessionId: "s2" },
      { ...createSlot(2, "t3", 300), status: "dead", sessionId: "s3" },
    );

    const sessions = [
      { sessionId: "s1", status: "processing" }, // fresh → busy
      { sessionId: "s2", status: "idle" }, // idle → idle (no change)
      { sessionId: "s3", status: "fresh", alive: true }, // dead → fresh (recovery)
    ];
    const updated = syncStatuses(pool, sessions);
    expect(updated).not.toBeNull();
    expect(updated.slots[0].status).toBe("busy");
    expect(updated.slots[1].status).toBe("idle");
    expect(updated.slots[2].status).toBe("fresh");
  });
});
