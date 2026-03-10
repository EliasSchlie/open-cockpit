import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPoolLock } from "../src/pool-lock.js";
import fs from "fs";
import os from "os";
import path from "path";

describe("withPoolLock", () => {
  let tmpDir;
  let poolFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-lock-test-"));
    poolFile = path.join(tmpDir, "pool.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serializes concurrent calls", async () => {
    const { withPoolLock } = createPoolLock(poolFile);
    const order = [];

    const a = withPoolLock(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
    });

    const b = withPoolLock(async () => {
      order.push("b-start");
      order.push("b-end");
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("recovers after sync throw — subsequent calls succeed", async () => {
    const { withPoolLock } = createPoolLock(poolFile);

    // First call throws synchronously
    await expect(
      withPoolLock(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");

    // Second call should still work — lock must not be poisoned
    const result = await withPoolLock(() => 42);
    expect(result).toBe(42);
  });

  it("recovers after async rejection — subsequent calls succeed", async () => {
    const { withPoolLock } = createPoolLock(poolFile);

    await expect(
      withPoolLock(async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");

    const result = await withPoolLock(() => "ok");
    expect(result).toBe("ok");
  });

  it("genuine nested calls hang (deadlock) — not recoverable by design", async () => {
    const { withPoolLock } = createPoolLock(poolFile);

    const nestedAttempt = withPoolLock(() => withPoolLock(() => "nested"));
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 100),
    );
    await expect(Promise.race([nestedAttempt, timeout])).rejects.toThrow(
      "timeout",
    );
  });

  it("handles multiple sync throws in sequence", async () => {
    const { withPoolLock } = createPoolLock(poolFile);

    for (let i = 0; i < 5; i++) {
      await expect(
        withPoolLock(() => {
          throw new Error(`throw-${i}`);
        }),
      ).rejects.toThrow(`throw-${i}`);
    }

    // Still works after 5 failures
    const result = await withPoolLock(() => "alive");
    expect(result).toBe("alive");
  });

  it("cleans up lockfile after successful operation", async () => {
    const { withPoolLock } = createPoolLock(poolFile);
    const lockFile = poolFile + ".lock";

    await withPoolLock(() => "done");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("cleans up lockfile after failed operation", async () => {
    const { withPoolLock } = createPoolLock(poolFile);
    const lockFile = poolFile + ".lock";

    await expect(
      withPoolLock(() => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("recovers from stale lockfile left by dead process", async () => {
    const lockFile = poolFile + ".lock";
    // Write a lockfile with a dead PID
    fs.writeFileSync(lockFile, "999999\n1234567890");

    const { withPoolLock } = createPoolLock(poolFile);
    const result = await withPoolLock(() => "recovered");
    expect(result).toBe("recovered");
  });

  it("cross-instance locking prevents concurrent access", async () => {
    // Two independent pool locks on the same file
    const lock1 = createPoolLock(poolFile);
    const lock2 = createPoolLock(poolFile);
    const order = [];

    const a = lock1.withPoolLock(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 100));
      order.push("a-end");
    });

    // Small delay so lock2 attempts after lock1 acquires
    await new Promise((r) => setTimeout(r, 10));

    const b = lock2.withPoolLock(async () => {
      order.push("b-start");
      order.push("b-end");
    });

    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
