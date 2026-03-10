import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let pool;
let poolLock;

beforeAll(() => {
  env = createTestEnv();
  pool = env.requireFresh("pool.js");
  poolLock = env.requireFresh("pool-lock.js");
});

afterAll(() => {
  env.cleanup();
});

describe("pool.js", () => {
  describe("readPool / writePool", () => {
    it("roundtrips pool data through write and read", () => {
      const poolFile = env.resolve("pool.json");
      const data = {
        poolSize: 3,
        slots: [
          {
            index: 0,
            termId: 1,
            pid: 1234,
            status: "fresh",
            sessionId: "sess-001",
            createdAt: "2025-01-01T00:00:00.000Z",
          },
          {
            index: 1,
            termId: 2,
            pid: 5678,
            status: "idle",
            sessionId: "sess-002",
            createdAt: "2025-01-01T00:00:01.000Z",
          },
        ],
        startedAt: "2025-01-01T00:00:00.000Z",
      };

      pool.writePool(poolFile, data);
      const result = pool.readPool(poolFile);

      expect(result).toEqual(data);
    });

    it("returns null for missing pool file", () => {
      const result = pool.readPool(env.resolve("nonexistent-pool.json"));
      expect(result).toBeNull();
    });
  });

  describe("isSlotUncommitted", () => {
    it("returns true for fresh", () => {
      expect(pool.isSlotUncommitted("fresh")).toBe(true);
    });

    it("returns true for typing", () => {
      expect(pool.isSlotUncommitted("typing")).toBe(true);
    });

    it("returns false for idle", () => {
      expect(pool.isSlotUncommitted("idle")).toBe(false);
    });

    it("returns false for busy", () => {
      expect(pool.isSlotUncommitted("busy")).toBe(false);
    });

    it("returns false for starting", () => {
      expect(pool.isSlotUncommitted("starting")).toBe(false);
    });

    it("returns false for dead", () => {
      expect(pool.isSlotUncommitted("dead")).toBe(false);
    });

    it("returns false for error", () => {
      expect(pool.isSlotUncommitted("error")).toBe(false);
    });
  });

  describe("computePoolHealth", () => {
    it("computes correct counts for mixed statuses", () => {
      const poolData = {
        poolSize: 4,
        slots: [
          {
            index: 0,
            termId: 1,
            pid: process.pid,
            status: "fresh",
            sessionId: "s1",
          },
          {
            index: 1,
            termId: 2,
            pid: process.pid,
            status: "idle",
            sessionId: "s2",
          },
          {
            index: 2,
            termId: 3,
            pid: process.pid,
            status: "busy",
            sessionId: "s3",
          },
          { index: 3, termId: 4, pid: 99999, status: "fresh", sessionId: "s4" },
        ],
      };

      const sessions = [
        { sessionId: "s1", status: "fresh", alive: true },
        {
          sessionId: "s2",
          status: "idle",
          alive: true,
          intentionHeading: "Task",
          cwd: "/tmp",
        },
        { sessionId: "s3", status: "processing", alive: true },
      ];

      const isAlive = (pid) => {
        try {
          process.kill(Number(pid), 0);
          return true;
        } catch {
          return false;
        }
      };

      const health = pool.computePoolHealth(poolData, sessions, isAlive);

      expect(health.initialized).toBe(true);
      expect(health.poolSize).toBe(4);
      // Slot 0: alive, fresh session -> starting (pool-fresh + processing override)
      // Slot 1: alive, idle session -> idle
      // Slot 2: alive, processing session -> processing
      // Slot 3: dead PID -> dead
      expect(health.counts.dead).toBe(1);
    });

    it("returns uninitialized for null pool", () => {
      const health = pool.computePoolHealth(null, [], () => false);
      expect(health.initialized).toBe(false);
    });
  });

  describe("syncStatuses", () => {
    it("updates slot status from session data", () => {
      const poolData = {
        slots: [
          { index: 0, sessionId: "s1", status: "fresh" },
          { index: 1, sessionId: "s2", status: "fresh" },
        ],
      };

      const sessions = [
        { sessionId: "s1", status: "idle", alive: true },
        { sessionId: "s2", status: "processing", alive: true },
      ];

      const result = pool.syncStatuses(poolData, sessions);

      expect(result).not.toBeNull();
      expect(result.slots[0].status).toBe("idle");
      expect(result.slots[1].status).toBe("busy");
    });

    it("returns null when nothing changed", () => {
      const poolData = {
        slots: [{ index: 0, sessionId: "s1", status: "idle" }],
      };

      const sessions = [{ sessionId: "s1", status: "idle", alive: true }];

      const result = pool.syncStatuses(poolData, sessions);
      expect(result).toBeNull();
    });

    it("skips starting slots", () => {
      const poolData = {
        slots: [{ index: 0, sessionId: "s1", status: "starting" }],
      };

      const sessions = [{ sessionId: "s1", status: "idle", alive: true }];

      const result = pool.syncStatuses(poolData, sessions);
      expect(result).toBeNull();
    });

    it("returns null for null pool", () => {
      expect(pool.syncStatuses(null, [])).toBeNull();
    });
  });

  describe("writePool atomic write", () => {
    it("produces valid JSON and cleans up tmp file", () => {
      const poolFile = env.resolve("pool-atomic.json");
      const data = {
        poolSize: 1,
        slots: [{ index: 0, status: "fresh" }],
      };

      pool.writePool(poolFile, data);

      // Pool file should exist and be valid JSON
      const content = fs.readFileSync(poolFile, "utf-8");
      expect(JSON.parse(content)).toEqual(data);

      // Tmp file should not exist
      expect(fs.existsSync(poolFile + ".tmp")).toBe(false);
    });
  });
});

describe("pool-lock.js", () => {
  describe("withPoolLock serializes", () => {
    it("serializes concurrent access", async () => {
      const { withPoolLock } = poolLock.createPoolLock();
      let counter = 0;

      const inc = () =>
        withPoolLock(async () => {
          const current = counter;
          // Simulate async work
          await new Promise((r) => setTimeout(r, 10));
          counter = current + 1;
        });

      // Launch two concurrent increments
      await Promise.all([inc(), inc()]);

      // If properly serialized, counter should be 2
      // Without serialization, both would read 0 and write 1
      expect(counter).toBe(2);
    });

    it("propagates errors without breaking the lock chain", async () => {
      const { withPoolLock } = poolLock.createPoolLock();

      // First call throws
      await expect(
        withPoolLock(async () => {
          throw new Error("intentional failure");
        }),
      ).rejects.toThrow("intentional failure");

      // Second call should still work
      const result = await withPoolLock(async () => "ok");
      expect(result).toBe("ok");
    });
  });
});
