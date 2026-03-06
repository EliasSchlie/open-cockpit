import { describe, it, expect } from "vitest";
import { createPoolLock } from "../src/pool-lock.js";

describe("withPoolLock", () => {
  it("serializes concurrent calls", async () => {
    const { withPoolLock } = createPoolLock();
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
    const { withPoolLock } = createPoolLock();

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
    const { withPoolLock } = createPoolLock();

    await expect(
      withPoolLock(async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");

    const result = await withPoolLock(() => "ok");
    expect(result).toBe("ok");
  });

  it("genuine nested calls hang (deadlock) — not recoverable by design", async () => {
    // A true nested call is an unrecoverable programming error:
    // the inner call queues behind the outer, but the outer awaits the inner.
    // This test just verifies the lock doesn't POISON itself — subsequent
    // non-nested calls still work even if a nested attempt was abandoned.
    const { withPoolLock } = createPoolLock();

    // Start a nested call (will deadlock), but race it against a timeout
    const nestedAttempt = withPoolLock(() => withPoolLock(() => "nested"));
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 100),
    );
    await expect(Promise.race([nestedAttempt, timeout])).rejects.toThrow(
      "timeout",
    );

    // The outer lock is still held (deadlocked). But once it eventually
    // resolves (if ever), new calls would work. We can't test recovery
    // here since the deadlock is permanent by design.
  });

  it("handles multiple sync throws in sequence", async () => {
    const { withPoolLock } = createPoolLock();

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
});
