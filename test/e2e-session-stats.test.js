/**
 * E2E tests for session stats with real Claude Code sessions.
 * Spawns REAL Claude sessions and verifies JSONL-based stats parsing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestEnv } from "./helpers/test-env.js";
import { spawnTestSession } from "./helpers/claude-harness.js";

let env;
const spawnedProcs = [];

beforeAll(() => {
  env = createTestEnv();
});

afterAll(() => {
  for (const proc of spawnedProcs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  env.cleanup();
});

describe("session stats E2E", { timeout: 120_000 }, () => {
  it("Test D: single session stats from real Claude call", async () => {
    const session = await spawnTestSession(env, {
      prompt: "What is the capital of France? One word only.",
    });
    spawnedProcs.push(session.process);

    const result = await session.waitForExit;
    expect(result.code).toBe(0);

    const { getSessionStats } = env.requireFresh("session-stats.js");
    const stats = await getSessionStats(session.sessionId);

    expect(stats.turns).toBeGreaterThanOrEqual(1);
    expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
    expect(stats.tokens.input).toBeGreaterThan(0);
    expect(stats.tokens.output).toBeGreaterThan(0);
    expect(stats.model).toMatch(/^claude/);
    expect(stats.estimatedCostUSD).toBeGreaterThan(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("Test E: PRICING is exported and has correct structure", () => {
    const { PRICING } = env.requireFresh("session-stats.js");

    // Verify PRICING has entries for opus, sonnet, haiku
    expect(PRICING["claude-opus-4-6"]).toBeDefined();
    expect(PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(PRICING["claude-haiku-4-5"]).toBeDefined();

    // Each entry has positive pricing fields
    for (const [, pricing] of Object.entries(PRICING)) {
      expect(pricing.input).toBeGreaterThan(0);
      expect(pricing.output).toBeGreaterThan(0);
      expect(pricing.cacheWrite).toBeGreaterThan(0);
      expect(pricing.cacheRead).toBeGreaterThan(0);
    }
  });
});
