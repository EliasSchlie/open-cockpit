/**
 * Crash recovery integration tests.
 *
 * Tests the active-sessions registry flow end-to-end:
 *   active pool → registry sync → simulated crash → restore detection
 *
 * Does NOT require a running daemon — tests the data layer that survives crashes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let activeSessions;
let secureFsModule;
let STATUS;

beforeAll(() => {
  env = createTestEnv("crash-recovery");
  activeSessions = env.requireFresh("active-sessions.js");
  secureFsModule = env.requireFresh("secure-fs.js");
  const statuses = env.requireFresh("session-statuses.js");
  STATUS = statuses.POOL_STATUS;
});

afterAll(() => {
  env.cleanup();
});

beforeEach(() => {
  // Clear registry and pool between tests
  try {
    fs.unlinkSync(env.resolve("active-sessions.json"));
  } catch {}
  try {
    fs.unlinkSync(env.resolve("pool.json"));
  } catch {}
});

describe("crash recovery via active-sessions registry", () => {
  function writePool(slots) {
    const poolData = {
      version: 1,
      size: slots.length,
      slots,
    };
    secureFsModule.secureWriteFileSync(
      env.resolve("pool.json"),
      JSON.stringify(poolData, null, 2),
    );
  }

  function makeSlot(sessionId, status, index) {
    return {
      index,
      sessionId,
      status,
      termId: index + 1,
      pid: 10000 + index,
      cwd: "/tmp",
    };
  }

  it("syncRegistryWithPool captures active sessions", () => {
    const slots = [
      makeSlot("sess-A", STATUS.BUSY, 0),
      makeSlot("sess-B", STATUS.IDLE, 1),
      makeSlot("sess-C", STATUS.FRESH, 2),
      makeSlot("sess-D", STATUS.TYPING, 3),
      makeSlot(null, STATUS.FRESH, 4),
    ];

    activeSessions.syncRegistryWithPool(slots);
    const registry = activeSessions.readActiveRegistry();

    // Only active statuses (busy, idle, typing) are registered
    expect(Object.keys(registry).sort()).toEqual([
      "sess-A",
      "sess-B",
      "sess-D",
    ]);
  });

  it("registry survives simulated crash", () => {
    // Phase 1: Normal operation — sessions are active
    const slots = [
      makeSlot("sess-A", STATUS.BUSY, 0),
      makeSlot("sess-B", STATUS.IDLE, 1),
    ];
    activeSessions.syncRegistryWithPool(slots);

    // Phase 2: Simulate crash — pool.json gets wiped (or becomes stale)
    try {
      fs.unlinkSync(env.resolve("pool.json"));
    } catch {}

    // Phase 3: After restart — registry file still has the sessions
    const registry = activeSessions.readActiveRegistry();
    expect(registry["sess-A"]).toBeDefined();
    expect(registry["sess-B"]).toBeDefined();
  });

  it("getSessionsToRestore identifies crashed sessions", () => {
    // Pre-crash: 3 sessions were active
    activeSessions.registerActiveSession("sess-A", "claude-A");
    activeSessions.registerActiveSession("sess-B", "claude-B");
    activeSessions.registerActiveSession("sess-C", "claude-C");

    // After restart: only sess-B is still alive in the new pool
    const liveSessionIds = new Set(["sess-B"]);
    const toRestore = activeSessions.getSessionsToRestore(liveSessionIds);

    expect(toRestore).toHaveLength(2);
    const ids = toRestore.map((r) => r.sessionId).sort();
    expect(ids).toEqual(["sess-A", "sess-C"]);

    // Each entry includes claudeSessionId for resume
    const entryA = toRestore.find((r) => r.sessionId === "sess-A");
    expect(entryA.claudeSessionId).toBe("claude-A");
  });

  it("full cycle: sync → crash → detect → restore list", () => {
    // Step 1: Normal operation with active sessions
    const slots = [
      makeSlot("sess-1", STATUS.BUSY, 0),
      makeSlot("sess-2", STATUS.IDLE, 1),
      makeSlot("sess-3", STATUS.TYPING, 2),
      makeSlot("sess-4", STATUS.FRESH, 3),
    ];
    activeSessions.syncRegistryWithPool(slots);

    // Step 2: Crash — pool gone, daemon gone, everything gone
    try {
      fs.unlinkSync(env.resolve("pool.json"));
    } catch {}

    // Step 3: App restarts with fresh pool (no sessions yet)
    const freshSlots = [
      makeSlot(null, STATUS.FRESH, 0),
      makeSlot(null, STATUS.FRESH, 1),
      makeSlot(null, STATUS.FRESH, 2),
      makeSlot(null, STATUS.FRESH, 3),
    ];
    writePool(freshSlots);

    // Step 4: Detect sessions that need restoring
    const liveSessionIds = new Set(); // nothing alive yet
    const toRestore = activeSessions.getSessionsToRestore(liveSessionIds);

    // All 3 active sessions (not the fresh one) should be in the restore list
    expect(toRestore).toHaveLength(3);
    const ids = toRestore.map((r) => r.sessionId).sort();
    expect(ids).toEqual(["sess-1", "sess-2", "sess-3"]);
  });

  it("sync during restore is suppressed", () => {
    // Pre-populate registry with sessions to restore
    activeSessions.registerActiveSession("sess-A", "claude-A");
    activeSessions.registerActiveSession("sess-B", "claude-B");

    // Simulate restore in progress
    activeSessions.setRestoreInProgress(true);
    try {
      // This sync would normally wipe the registry (no active slots)
      activeSessions.syncRegistryWithPool([]);

      // Registry should be unchanged — sync was suppressed
      const registry = activeSessions.readActiveRegistry();
      expect(registry["sess-A"]).toBeDefined();
      expect(registry["sess-B"]).toBeDefined();
    } finally {
      activeSessions.setRestoreInProgress(false);
    }
  });

  it("unregister removes restored session from registry", () => {
    activeSessions.registerActiveSession("sess-A", "claude-A");
    activeSessions.registerActiveSession("sess-B", "claude-B");

    // Simulate successful restore of sess-A
    activeSessions.unregisterActiveSession("sess-A");

    const registry = activeSessions.readActiveRegistry();
    expect(registry["sess-A"]).toBeUndefined();
    expect(registry["sess-B"]).toBeDefined();
  });

  it("handles corrupt registry gracefully", () => {
    // Write garbage to registry file
    fs.writeFileSync(env.resolve("active-sessions.json"), "{{not json!!");

    // Should return empty, not throw
    const registry = activeSessions.readActiveRegistry();
    expect(registry).toEqual({});

    // getSessionsToRestore should also handle gracefully
    const toRestore = activeSessions.getSessionsToRestore(new Set());
    expect(toRestore).toEqual([]);
  });

  it("handles missing registry file gracefully", () => {
    // No file at all
    const toRestore = activeSessions.getSessionsToRestore(new Set());
    expect(toRestore).toEqual([]);
  });
});
