import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  readPool,
  writePool,
  createPool,
  createSlot,
  resolveSlot,
  selectShrinkCandidates,
  computePoolHealth,
  syncStatuses,
} from "../src/pool.js";

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

  it("skips processing and dead slots", () => {
    const slots = [
      { index: 0, status: "processing" },
      { index: 1, status: "dead" },
      { index: 2, status: "idle" },
    ];
    const result = selectShrinkCandidates(slots, 5);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(2);
  });

  it("returns empty array when all busy", () => {
    const slots = [
      { index: 0, status: "processing" },
      { index: 1, status: "processing" },
    ];
    expect(selectShrinkCandidates(slots, 1)).toEqual([]);
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

    // Shrink by 3: 2 fresh + 1 idle
    const victims2 = selectShrinkCandidates(pool.slots, 3);
    expect(victims2.map((v) => v.index)).toEqual([1, 3, 0]);
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
