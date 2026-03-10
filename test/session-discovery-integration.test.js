import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let discovery;
let paths;

const ALIVE_PID = String(process.pid);
const DEAD_PID = "99999";

// Verify DEAD_PID is actually dead
try {
  process.kill(Number(DEAD_PID), 0);
  throw new Error(`PID ${DEAD_PID} is alive — pick a different dead PID`);
} catch (e) {
  if (e.message?.includes("is alive")) throw e;
}

beforeAll(() => {
  env = createTestEnv();
  discovery = env.requireFresh("session-discovery.js");
  paths = env.requireFresh("paths.js");
  discovery.init({ debugLog: () => {}, onSessionsChanged: () => {} });
});

afterAll(() => {
  env.cleanup();
});

beforeEach(() => {
  // Invalidate cache between tests so each gets a fresh read
  discovery.invalidateSessionsCache();
});

describe("session-discovery integration", () => {
  it("discovers a live session from PID file", async () => {
    const sessionId = "aaaa-1111-live-session";
    env.writeFile(`session-pids/${ALIVE_PID}`, sessionId);

    const sessions = await discovery.getSessions();
    const found = sessions.find((s) => s.sessionId === sessionId);

    expect(found).toBeDefined();
    expect(found.alive).toBe(true);
    expect(found.pid).toBe(ALIVE_PID);

    // Cleanup
    fs.unlinkSync(env.resolve(`session-pids/${ALIVE_PID}`));
  });

  it("cleans up dead session without intention", async () => {
    const sessionId = "bbbb-2222-dead-no-intention";
    env.writeFile(`session-pids/${DEAD_PID}`, sessionId);

    const sessions = await discovery.getSessions();
    const found = sessions.find((s) => s.sessionId === sessionId);

    // Dead session without intention is silently removed
    expect(found).toBeUndefined();
    // PID file should have been deleted
    expect(fs.existsSync(env.resolve(`session-pids/${DEAD_PID}`))).toBe(false);
  });

  it("auto-archives dead session with intention heading", async () => {
    const sessionId = "cccc-3333-dead-with-intention";
    env.writeFile(`session-pids/${DEAD_PID}`, sessionId);
    env.writeFile(`intentions/${sessionId}.md`, "# My Task\nSome details");

    const sessions = await discovery.getSessions();

    // Dead session with intention should be archived (appears in offloaded dir)
    const offloadMetaPath = env.resolve(`offloaded/${sessionId}/meta.json`);
    expect(fs.existsSync(offloadMetaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(offloadMetaPath, "utf-8"));
    expect(meta.sessionId).toBe(sessionId);
    expect(meta.intentionHeading).toBe("My Task");
    expect(meta.archived).toBe(true);

    // PID file should be cleaned up
    expect(fs.existsSync(env.resolve(`session-pids/${DEAD_PID}`))).toBe(false);

    // Cleanup
    fs.rmSync(env.resolve(`offloaded/${sessionId}`), { recursive: true });
    fs.unlinkSync(env.resolve(`intentions/${sessionId}.md`));
  });

  it("marks session as idle when idle signal with non-fresh trigger exists", async () => {
    const sessionId = "dddd-4444-idle-session";
    env.writeFile(`session-pids/${ALIVE_PID}`, sessionId);

    // Write idle signal with a non-fresh trigger (tool-use marks session as activated)
    const idleSignal = {
      ts: Math.floor(Date.now() / 1000),
      trigger: "tool-use",
      session_id: sessionId,
      transcript: "/nonexistent/path/to/transcript.jsonl",
    };
    env.writeJson(`idle-signals/${ALIVE_PID}`, idleSignal);

    const sessions = await discovery.getSessions();
    const found = sessions.find((s) => s.sessionId === sessionId);

    expect(found).toBeDefined();
    expect(found.status).toBe("idle");
    expect(found.alive).toBe(true);

    // Cleanup
    fs.unlinkSync(env.resolve(`session-pids/${ALIVE_PID}`));
    fs.unlinkSync(env.resolve(`idle-signals/${ALIVE_PID}`));
  });

  it("marks live session without idle signal as fresh or processing", async () => {
    const sessionId = "eeee-5555-no-idle-signal";
    env.writeFile(`session-pids/${ALIVE_PID}`, sessionId);

    const sessions = await discovery.getSessions();
    const found = sessions.find((s) => s.sessionId === sessionId);

    expect(found).toBeDefined();
    expect(found.alive).toBe(true);
    // Without idle signal and without transcript, should be fresh
    expect(["fresh", "typing", "processing"]).toContain(found.status);

    // Cleanup
    fs.unlinkSync(env.resolve(`session-pids/${ALIVE_PID}`));
  });

  it("returns offloaded session from meta.json", async () => {
    const sessionId = "ffff-6666-offloaded";
    const meta = {
      sessionId,
      claudeSessionId: sessionId,
      cwd: "/tmp/test-project",
      gitRoot: null,
      intentionHeading: "Test Offloaded",
      lastInteractionTs: Math.floor(Date.now() / 1000),
    };
    env.writeJson(`offloaded/${sessionId}/meta.json`, meta);
    // Need a snapshot for it to not be auto-archived/deleted
    env.writeFile(`offloaded/${sessionId}/snapshot.log`, "some snapshot data");

    const sessions = await discovery.getSessions();
    const found = sessions.find((s) => s.sessionId === sessionId);

    expect(found).toBeDefined();
    expect(found.status).toBe("offloaded");
    expect(found.alive).toBe(false);
    expect(found.intentionHeading).toBe("Test Offloaded");

    // Cleanup
    fs.rmSync(env.resolve(`offloaded/${sessionId}`), { recursive: true });
  });

  it("returns archived session when meta has archived flag", async () => {
    const sessionId = "aaaa-7777-archived";
    const meta = {
      sessionId,
      claudeSessionId: sessionId,
      cwd: "/tmp/archived-project",
      gitRoot: null,
      intentionHeading: "Archived Task",
      lastInteractionTs: Math.floor(Date.now() / 1000),
      archived: true,
      archivedAt: new Date().toISOString(),
    };
    env.writeJson(`offloaded/${sessionId}/meta.json`, meta);
    env.writeFile(`offloaded/${sessionId}/snapshot.log`, "snapshot");

    const sessions = await discovery.getSessions();
    const found = sessions.find((s) => s.sessionId === sessionId);

    expect(found).toBeDefined();
    expect(found.status).toBe("archived");
    expect(found.alive).toBe(false);

    // Cleanup
    fs.rmSync(env.resolve(`offloaded/${sessionId}`), { recursive: true });
  });

  it("invalidates cache so new sessions appear", async () => {
    const sessionId1 = "bbbb-8888-first";
    const sessionId2 = "cccc-9999-second";

    env.writeFile(`session-pids/${ALIVE_PID}`, sessionId1);
    const sessions1 = await discovery.getSessions();
    const found1 = sessions1.find((s) => s.sessionId === sessionId1);
    expect(found1).toBeDefined();

    // The second session ID won't show up because the PID file is overwritten.
    // Instead, test cache invalidation with an offloaded session.
    discovery.invalidateSessionsCache();

    // Overwrite to a new session ID
    env.writeFile(`session-pids/${ALIVE_PID}`, sessionId2);

    const sessions2 = await discovery.getSessions();
    const found2 = sessions2.find((s) => s.sessionId === sessionId2);
    expect(found2).toBeDefined();

    // Cleanup
    fs.unlinkSync(env.resolve(`session-pids/${ALIVE_PID}`));
  });
});
