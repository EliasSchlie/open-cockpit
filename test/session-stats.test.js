import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { createTestEnv } from "./helpers/test-env.js";

const require = createRequire(import.meta.url);

let env;
let stats; // cached wrapper module

// parseJsonlStats, getPricing, findChildSessionIds, findAllDescendants are NOT
// exported from session-stats.js. We extract them via a wrapper module that
// stubs out the external dependencies (session-discovery, pool-manager, paths).

beforeAll(() => {
  env = createTestEnv("session-stats-test");
  stats = loadParseJsonlStats();
});

afterAll(() => {
  env.cleanup();
});

function writeJsonl(filename, lines) {
  const filePath = env.resolve(filename);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

function loadParseJsonlStats() {
  const wrapperPath = env.resolve("_stats_wrapper.js");
  const srcPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../src/session-stats.js",
  );
  const src = fs.readFileSync(srcPath, "utf-8");

  const patched = src
    .replace(
      /const \{ findJsonlPath \}.*\n/,
      "const findJsonlPath = () => null;\n",
    )
    .replace(
      /const \{ readSessionGraph \}.*\n/,
      "const readSessionGraph = () => ({});\n",
    )
    .replace(
      /const \{ CLAUDE_PROJECTS_DIR \}.*\n/,
      'const CLAUDE_PROJECTS_DIR = "/tmp";\n',
    )
    .replace(/const \{ execFile \}.*\n/, "")
    .replace(/const \{ promisify \}.*\n/, "")
    .replace(/const execFileAsync.*\n/, "")
    .replace(
      /module\.exports\s*=\s*\{[^}]*\};?\s*$/m,
      `module.exports = {
  parseJsonlStats, PRICING, estimateCost, getPricing, emptyTokens,
  findChildSessionIds, findAllDescendants,
};`,
    );

  fs.writeFileSync(wrapperPath, patched);
  delete require.cache[wrapperPath];
  return require(wrapperPath);
}

describe("PRICING", () => {
  it("has pricing for known models", () => {
    const { PRICING } = stats;

    expect(PRICING["claude-opus-4-6"]).toBeDefined();
    expect(PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(PRICING["claude-haiku-4-5"]).toBeDefined();
  });

  it("pricing entries have all required fields", () => {
    const { PRICING } = stats;

    for (const [model, pricing] of Object.entries(PRICING)) {
      expect(pricing.input).toBeTypeOf("number");
      expect(pricing.output).toBeTypeOf("number");
      expect(pricing.cacheWrite).toBeTypeOf("number");
      expect(pricing.cacheRead).toBeTypeOf("number");
    }
  });
});

describe("parseJsonlStats", () => {
  it("parses tokens correctly", async () => {
    const { parseJsonlStats } = stats;
    const filePath = writeJsonl("tokens.jsonl", [
      {
        type: "user",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:01:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 10,
          },
        },
      },
    ]);

    const result = await parseJsonlStats(filePath);

    expect(result.tokens.input).toBe(100);
    expect(result.tokens.output).toBe(50);
    expect(result.tokens.cacheCreation).toBe(20);
    expect(result.tokens.cacheRead).toBe(10);
  });

  it("accumulates tokens across multiple assistant messages", async () => {
    const { parseJsonlStats } = stats;
    const filePath = writeJsonl("multi-tokens.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:01:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [],
          usage: { input_tokens: 200, output_tokens: 75 },
        },
      },
    ]);

    const result = await parseJsonlStats(filePath);

    expect(result.tokens.input).toBe(300);
    expect(result.tokens.output).toBe(125);
  });

  it("computes cost estimate correctly for Sonnet", async () => {
    const { parseJsonlStats, PRICING } = stats;
    const filePath = writeJsonl("cost.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
          },
        },
      },
    ]);

    const result = await parseJsonlStats(filePath);
    const p = PRICING["claude-sonnet-4-6"];
    const expectedCost = p.input + p.output + p.cacheWrite + p.cacheRead;

    expect(result.estimatedCostUSD).toBeCloseTo(expectedCost, 6);
  });

  it("computes cost estimate correctly for Opus", async () => {
    const { parseJsonlStats, PRICING } = stats;
    const filePath = writeJsonl("cost-opus.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [],
          usage: {
            input_tokens: 500_000,
            output_tokens: 200_000,
          },
        },
      },
    ]);

    const result = await parseJsonlStats(filePath);
    const p = PRICING["claude-opus-4-6"];
    const expectedCost =
      (500_000 * p.input) / 1_000_000 + (200_000 * p.output) / 1_000_000;

    expect(result.estimatedCostUSD).toBeCloseTo(expectedCost, 6);
  });

  it("counts turns (user messages) and assistant messages", async () => {
    const { parseJsonlStats } = stats;
    const filePath = writeJsonl("counts.jsonl", [
      {
        type: "user",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "q1" },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:00:30Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [{ type: "text", text: "a1" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "user",
        timestamp: "2024-01-01T00:01:00Z",
        message: { role: "user", content: "q2" },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:01:30Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [{ type: "text", text: "a2" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "user",
        timestamp: "2024-01-01T00:02:00Z",
        message: { role: "user", content: "q3" },
      },
    ]);

    const result = await parseJsonlStats(filePath);

    expect(result.turns).toBe(3);
    expect(result.assistantMessages).toBe(2);
  });

  it("counts tool uses in assistant content blocks", async () => {
    const { parseJsonlStats } = stats;
    const filePath = writeJsonl("tools.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", id: "t1", name: "Read", input: {} },
            { type: "tool_use", id: "t2", name: "Bash", input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:01:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [{ type: "tool_use", id: "t3", name: "Edit", input: {} }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    const result = await parseJsonlStats(filePath);

    expect(result.toolUses).toBe(3);
  });

  it("determines primary model from mixed-model conversation", async () => {
    const { parseJsonlStats } = stats;
    const filePath = writeJsonl("mixed-model.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          model: "claude-haiku-4-5",
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:01:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:02:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:03:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    const result = await parseJsonlStats(filePath);

    expect(result.model).toBe("claude-sonnet-4-6-20250514");
  });

  it("computes duration from first/last timestamp", async () => {
    const { parseJsonlStats } = stats;
    const filePath = writeJsonl("duration.jsonl", [
      {
        type: "user",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "start" },
      },
      {
        type: "assistant",
        timestamp: "2024-01-01T00:05:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "user",
        timestamp: "2024-01-01T00:10:00Z",
        message: { role: "user", content: "end" },
      },
    ]);

    const result = await parseJsonlStats(filePath);

    // 10 minutes = 600,000 ms
    expect(result.durationMs).toBe(600_000);
  });

  it("handles empty JSONL gracefully", async () => {
    const { parseJsonlStats } = stats;
    const filePath = env.resolve("empty.jsonl");
    fs.writeFileSync(filePath, "");

    const result = await parseJsonlStats(filePath);

    expect(result.tokens.input).toBe(0);
    expect(result.tokens.output).toBe(0);
    expect(result.turns).toBe(0);
    expect(result.assistantMessages).toBe(0);
    expect(result.toolUses).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.model).toBe(null);
    expect(result.estimatedCostUSD).toBe(0);
  });

  it("handles corrupt lines gracefully (skips them)", async () => {
    const { parseJsonlStats } = stats;
    const filePath = env.resolve("corrupt.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2024-01-01T00:00:00Z",
        message: { role: "user", content: "hello" },
      }),
      "this is not valid json {{{",
      "",
      "another broken line",
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-01-01T00:01:00Z",
        message: {
          model: "claude-sonnet-4-6-20250514",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      }),
    ];
    fs.writeFileSync(filePath, lines.join("\n"));

    const result = await parseJsonlStats(filePath);

    // Should have parsed the valid lines, skipping corrupt ones
    expect(result.turns).toBe(1);
    expect(result.assistantMessages).toBe(1);
    expect(result.tokens.input).toBe(50);
    expect(result.tokens.output).toBe(25);
  });
});

describe("findChildSessionIds", () => {
  it("finds direct children in a session graph", () => {
    const { findChildSessionIds } = stats;
    const graph = {
      "child-1": { parentSessionId: "parent-1" },
      "child-2": { parentSessionId: "parent-1" },
      "child-3": { parentSessionId: "parent-2" },
      "grandchild-1": { parentSessionId: "child-1" },
    };

    const children = findChildSessionIds("parent-1", graph);

    expect(children).toContain("child-1");
    expect(children).toContain("child-2");
    expect(children).toHaveLength(2);
  });

  it("returns empty array when no children exist", () => {
    const { findChildSessionIds } = stats;
    const graph = {
      "child-1": { parentSessionId: "other-parent" },
    };

    expect(findChildSessionIds("no-children", graph)).toEqual([]);
  });
});

describe("findAllDescendants", () => {
  it("finds all descendants recursively", () => {
    const { findAllDescendants } = stats;
    const graph = {
      "child-1": { parentSessionId: "root" },
      "child-2": { parentSessionId: "root" },
      "grandchild-1": { parentSessionId: "child-1" },
      "grandchild-2": { parentSessionId: "child-1" },
      "great-grandchild": { parentSessionId: "grandchild-1" },
    };

    const descendants = findAllDescendants("root", graph);

    expect(descendants).toContain("child-1");
    expect(descendants).toContain("child-2");
    expect(descendants).toContain("grandchild-1");
    expect(descendants).toContain("grandchild-2");
    expect(descendants).toContain("great-grandchild");
    expect(descendants).toHaveLength(5);
  });

  it("returns empty array for leaf nodes", () => {
    const { findAllDescendants } = stats;
    const graph = {
      "child-1": { parentSessionId: "root" },
    };

    expect(findAllDescendants("child-1", graph)).toEqual([]);
  });
});

describe("getPricing", () => {
  it("matches partial model names with date suffix", () => {
    const { getPricing, PRICING } = stats;

    expect(getPricing("claude-sonnet-4-6-20250514")).toBe(
      PRICING["claude-sonnet-4-6"],
    );
    expect(getPricing("claude-opus-4-6")).toBe(PRICING["claude-opus-4-6"]);
  });

  it("returns default (Sonnet) pricing for unknown models", () => {
    const { getPricing, PRICING } = stats;

    expect(getPricing("unknown-model")).toBe(PRICING["claude-sonnet-4-6"]);
    expect(getPricing(null)).toBe(PRICING["claude-sonnet-4-6"]);
  });
});
