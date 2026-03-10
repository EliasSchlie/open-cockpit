import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let activeSessionsModule;

beforeAll(() => {
  env = createTestEnv();
  activeSessionsModule = env.requireFresh("active-sessions.js");
});

afterAll(() => {
  env.cleanup();
});

beforeEach(() => {
  // Clear registry between tests
  try {
    fs.unlinkSync(env.resolve("active-sessions.json"));
  } catch {}
});

describe("active-sessions registry", () => {
  describe("registerActiveSession", () => {
    it("adds a session to the registry", () => {
      activeSessionsModule.registerActiveSession("sess-001", "sess-001");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(registry["sess-001"]).toEqual({ claudeSessionId: "sess-001" });
    });

    it("stores claudeSessionId separately when different", () => {
      activeSessionsModule.registerActiveSession("sess-001", "claude-abc");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(registry["sess-001"].claudeSessionId).toBe("claude-abc");
    });

    it("overwrites existing entry", () => {
      activeSessionsModule.registerActiveSession("sess-001", "old-id");
      activeSessionsModule.registerActiveSession("sess-001", "new-id");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(registry["sess-001"].claudeSessionId).toBe("new-id");
    });

    it("handles multiple sessions", () => {
      activeSessionsModule.registerActiveSession("sess-001", "sess-001");
      activeSessionsModule.registerActiveSession("sess-002", "sess-002");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(Object.keys(registry)).toHaveLength(2);
    });
  });

  describe("unregisterActiveSession", () => {
    it("removes a session from the registry", () => {
      activeSessionsModule.registerActiveSession("sess-001", "sess-001");
      activeSessionsModule.unregisterActiveSession("sess-001");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(registry["sess-001"]).toBeUndefined();
    });

    it("is a no-op for missing session", () => {
      activeSessionsModule.unregisterActiveSession("nonexistent");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(Object.keys(registry)).toHaveLength(0);
    });

    it("leaves other sessions intact", () => {
      activeSessionsModule.registerActiveSession("sess-001", "sess-001");
      activeSessionsModule.registerActiveSession("sess-002", "sess-002");
      activeSessionsModule.unregisterActiveSession("sess-001");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(registry["sess-002"]).toBeDefined();
      expect(registry["sess-001"]).toBeUndefined();
    });
  });

  describe("readActiveRegistry", () => {
    it("returns empty object when no file", () => {
      const registry = activeSessionsModule.readActiveRegistry();
      expect(registry).toEqual({});
    });

    it("returns empty object for corrupt file", () => {
      fs.writeFileSync(env.resolve("active-sessions.json"), "not json{{{");
      const registry = activeSessionsModule.readActiveRegistry();
      expect(registry).toEqual({});
    });
  });

  describe("getSessionsToRestore", () => {
    it("returns sessions in registry but not in live set", () => {
      activeSessionsModule.registerActiveSession("sess-001", "sess-001");
      activeSessionsModule.registerActiveSession("sess-002", "sess-002");
      activeSessionsModule.registerActiveSession("sess-003", "sess-003");

      const liveSessionIds = new Set(["sess-002"]);
      const toRestore =
        activeSessionsModule.getSessionsToRestore(liveSessionIds);
      expect(toRestore).toHaveLength(2);
      expect(toRestore.map((r) => r.sessionId).sort()).toEqual([
        "sess-001",
        "sess-003",
      ]);
      expect(toRestore[0].claudeSessionId).toBeDefined();
    });

    it("returns empty when all sessions are live", () => {
      activeSessionsModule.registerActiveSession("sess-001", "sess-001");
      const liveSessionIds = new Set(["sess-001"]);
      const toRestore =
        activeSessionsModule.getSessionsToRestore(liveSessionIds);
      expect(toRestore).toHaveLength(0);
    });

    it("returns empty when registry is empty", () => {
      const toRestore = activeSessionsModule.getSessionsToRestore(new Set());
      expect(toRestore).toHaveLength(0);
    });
  });

  describe("syncRegistryWithPool", () => {
    it("registers active sessions and removes inactive ones", () => {
      // Pre-populate with an old session that's no longer in pool
      activeSessionsModule.registerActiveSession("old-sess", "old-sess");

      const slots = [
        { sessionId: "sess-001", status: "idle" },
        { sessionId: "sess-002", status: "busy" },
        { sessionId: "sess-003", status: "fresh" },
        { sessionId: "sess-004", status: "typing" },
        { sessionId: null, status: "starting" },
      ];

      activeSessionsModule.syncRegistryWithPool(slots);
      const registry = activeSessionsModule.readActiveRegistry();

      // idle, busy, typing should be registered
      expect(registry["sess-001"]).toBeDefined();
      expect(registry["sess-002"]).toBeDefined();
      expect(registry["sess-004"]).toBeDefined();
      // fresh and starting should not
      expect(registry["sess-003"]).toBeUndefined();
      // old session should be removed
      expect(registry["old-sess"]).toBeUndefined();
    });

    it("skips write when registry is unchanged", () => {
      const slots = [
        { sessionId: "sess-001", status: "idle" },
        { sessionId: "sess-002", status: "busy" },
      ];

      activeSessionsModule.syncRegistryWithPool(slots);
      const mtime1 = fs.statSync(env.resolve("active-sessions.json")).mtimeMs;

      // Sync again with same slots — should not write
      activeSessionsModule.syncRegistryWithPool(slots);
      const mtime2 = fs.statSync(env.resolve("active-sessions.json")).mtimeMs;

      expect(mtime2).toBe(mtime1);
    });

    it("skips sync when restore is in progress", () => {
      activeSessionsModule.registerActiveSession("sess-001", "sess-001");
      activeSessionsModule.setRestoreInProgress(true);
      try {
        // This should be a no-op — registry should keep sess-001
        activeSessionsModule.syncRegistryWithPool([]);
        const registry = activeSessionsModule.readActiveRegistry();
        expect(registry["sess-001"]).toBeDefined();
      } finally {
        activeSessionsModule.setRestoreInProgress(false);
      }
    });

    it("preserves entries from pending-restore.json", () => {
      // No active pool slots, but pending-restore has sessions to preserve
      env.writeJson("pending-restore.json", ["restore-001", "restore-002"]);

      activeSessionsModule.syncRegistryWithPool([]);
      const registry = activeSessionsModule.readActiveRegistry();

      expect(registry["restore-001"]).toEqual({
        claudeSessionId: "restore-001",
      });
      expect(registry["restore-002"]).toEqual({
        claudeSessionId: "restore-002",
      });
    });

    it("merges active pool slots with pending-restore entries", () => {
      env.writeJson("pending-restore.json", ["restore-001"]);

      const slots = [
        { sessionId: "active-001", status: "idle" },
        { sessionId: "active-002", status: "busy" },
      ];

      activeSessionsModule.syncRegistryWithPool(slots);
      const registry = activeSessionsModule.readActiveRegistry();

      // Both active slots and pending-restore entry should be present
      expect(registry["active-001"]).toBeDefined();
      expect(registry["active-002"]).toBeDefined();
      expect(registry["restore-001"]).toBeDefined();
      expect(Object.keys(registry)).toHaveLength(3);
    });

    it("does not duplicate entries present in both pool and pending-restore", () => {
      // Session is both active in pool and listed in pending-restore
      env.writeJson("pending-restore.json", ["sess-001"]);

      const slots = [{ sessionId: "sess-001", status: "idle" }];

      activeSessionsModule.syncRegistryWithPool(slots);
      const registry = activeSessionsModule.readActiveRegistry();

      expect(Object.keys(registry)).toHaveLength(1);
      expect(registry["sess-001"]).toBeDefined();
    });

    it("handles missing pending-restore.json gracefully", () => {
      // No pending-restore file — should work exactly as before
      const slots = [{ sessionId: "sess-001", status: "idle" }];

      activeSessionsModule.syncRegistryWithPool(slots);
      const registry = activeSessionsModule.readActiveRegistry();

      expect(Object.keys(registry)).toHaveLength(1);
      expect(registry["sess-001"]).toBeDefined();
    });

    it("handles corrupt pending-restore.json gracefully", () => {
      env.writeFile("pending-restore.json", "not valid json{{{");

      const slots = [{ sessionId: "sess-001", status: "idle" }];

      activeSessionsModule.syncRegistryWithPool(slots);
      const registry = activeSessionsModule.readActiveRegistry();

      // Should still sync pool slots despite corrupt file
      expect(Object.keys(registry)).toHaveLength(1);
      expect(registry["sess-001"]).toBeDefined();
    });
  });
});
