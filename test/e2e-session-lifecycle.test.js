/**
 * E2E tests for session lifecycle: spawn -> discover -> archive -> unarchive.
 * Spawns REAL Claude Code sessions. No mocking.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { createTestEnv } from "./helpers/test-env.js";
import {
  spawnTestSession,
  writeIdleSignal,
  writeOffloadMeta,
} from "./helpers/claude-harness.js";

let env;
const spawnedProcs = [];

beforeAll(() => {
  env = createTestEnv();
});

afterAll(() => {
  // Kill any Claude processes still running
  for (const proc of spawnedProcs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  env.cleanup();
});

describe("session lifecycle", { timeout: 120_000 }, () => {
  it("Test A: spawn -> discover -> exit -> auto-archive", async () => {
    // 1. Spawn Claude with a simple prompt
    const session = await spawnTestSession(env, {
      prompt: "Say exactly: hello",
    });
    spawnedProcs.push(session.process);

    // 2. PID file already written by harness — load session-discovery
    const sd = env.requireFresh("session-discovery.js");
    sd.init({ debugLog: () => {}, onSessionsChanged: () => {} });

    // 3. Session should be discoverable while alive
    let sessions = await sd.getSessions();
    const liveSess = sessions.find((s) => s.sessionId === session.sessionId);
    expect(liveSess).toBeDefined();
    expect(liveSess.alive).toBe(true);

    // 4. Wait for Claude to finish
    const result = await session.waitForExit;
    expect(result.code).toBe(0);

    // 5. Write intention file (simulating hook)
    env.writeFile(
      `intentions/${session.sessionId}.md`,
      "# Test Session\nSaid hello",
    );

    // 6. Invalidate cache and re-check — dead session with intention → archived
    sd.invalidateSessionsCache();
    sessions = await sd.getSessions();
    const archivedSess = sessions.find(
      (s) => s.sessionId === session.sessionId,
    );
    expect(archivedSess).toBeDefined();
    expect(archivedSess.status).toBe("archived");
  });

  it("Test B: prompt with stats verification", async () => {
    const session = await spawnTestSession(env, {
      prompt: "What is 2+2? Reply with just the number.",
    });
    spawnedProcs.push(session.process);

    const result = await session.waitForExit;
    expect(result.code).toBe(0);

    // Load session-stats — getSessionStats uses findJsonlPath which searches
    // ~/.claude/projects/ (real Claude data dir, not affected by test dir)
    const { getSessionStats } = env.requireFresh("session-stats.js");
    const stats = await getSessionStats(session.sessionId);

    expect(stats.turns).toBeGreaterThanOrEqual(1);
    expect(stats.tokens.input).toBeGreaterThan(0);
    expect(stats.tokens.output).toBeGreaterThan(0);
    expect(stats.estimatedCostUSD).toBeGreaterThan(0);
  });

  it("Test C: offload -> archive -> unarchive flow (synthetic)", async () => {
    const id = crypto.randomUUID();

    // 1. Create offloaded session with snapshot
    writeOffloadMeta(env, id, {
      intentionHeading: "Test offloaded session",
      archived: false,
    });
    env.writeFile(`offloaded/${id}/snapshot.log`, "terminal content here");

    // 2. Load session-discovery fresh
    const sd = env.requireFresh("session-discovery.js");
    sd.init({ debugLog: () => {}, onSessionsChanged: () => {} });

    let sessions = await sd.getSessions();
    let sess = sessions.find((s) => s.sessionId === id);
    expect(sess).toBeDefined();
    expect(sess.status).toBe("offloaded");

    // 3. Archive: update meta
    writeOffloadMeta(env, id, {
      intentionHeading: "Test offloaded session",
      archived: true,
      archivedAt: new Date().toISOString(),
    });

    sd.invalidateSessionsCache();
    sessions = await sd.getSessions();
    sess = sessions.find((s) => s.sessionId === id);
    expect(sess).toBeDefined();
    expect(sess.status).toBe("archived");

    // 4. Unarchive: remove archived flag
    writeOffloadMeta(env, id, {
      intentionHeading: "Test offloaded session",
    });

    sd.invalidateSessionsCache();
    sessions = await sd.getSessions();
    sess = sessions.find((s) => s.sessionId === id);
    expect(sess).toBeDefined();
    expect(sess.status).toBe("offloaded");
  });
});
