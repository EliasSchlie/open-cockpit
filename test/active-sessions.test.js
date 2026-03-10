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
  });
});
