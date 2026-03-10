import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const TMP_DIR = path.join(
  os.tmpdir(),
  "open-cockpit-session-stats-test-" + process.pid,
);

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // Clear cached modules for fresh imports
  for (const key of Object.keys(require.cache)) {
    if (key.includes("/src/")) delete require.cache[key];
  }
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// parseJsonlStats, getPricing, findChildSessionIds, findAllDescendants are NOT
// exported from session-stats.js. We extract them via a wrapper module that
// stubs out the external dependencies (session-discovery, pool-manager, paths).

function writeJsonl(filename, lines) {
  const filePath = path.join(TMP_DIR, filename);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

function loadParseJsonlStats() {
  const wrapperPath = path.join(TMP_DIR, "_stats_wrapper.js");
  const srcPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../src/session-stats.js",
  );
  const src = fs.readFileSync(srcPath, "utf-8");

  // Replace external requires with stubs, strip the existing module.exports,
  // then append our own exports of the internal functions.
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
    const { PRICING } = loadParseJsonlStats();

    expect(PRICING["claude-opus-4-6"]).toBeDefined();
    expect(PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(PRICING["claude-haiku-4-5"]).toBeDefined();
  });

  it("pricing entries have all required fields", () => {
    const { PRICING } = loadParseJsonlStats();

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
    const { parseJsonlStats } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);

    expect(stats.tokens.input).toBe(100);
    expect(stats.tokens.output).toBe(50);
    expect(stats.tokens.cacheCreation).toBe(20);
    expect(stats.tokens.cacheRead).toBe(10);
  });

  it("accumulates tokens across multiple assistant messages", async () => {
    const { parseJsonlStats } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);

    expect(stats.tokens.input).toBe(300);
    expect(stats.tokens.output).toBe(125);
  });

  it("computes cost estimate correctly for Sonnet", async () => {
    const { parseJsonlStats, PRICING } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);
    const p = PRICING["claude-sonnet-4-6"];
    const expectedCost = p.input + p.output + p.cacheWrite + p.cacheRead;

    expect(stats.estimatedCostUSD).toBeCloseTo(expectedCost, 6);
  });

  it("computes cost estimate correctly for Opus", async () => {
    const { parseJsonlStats, PRICING } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);
    const p = PRICING["claude-opus-4-6"];
    const expectedCost =
      (500_000 * p.input) / 1_000_000 + (200_000 * p.output) / 1_000_000;

    expect(stats.estimatedCostUSD).toBeCloseTo(expectedCost, 6);
  });

  it("counts turns (user messages) and assistant messages", async () => {
    const { parseJsonlStats } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);

    expect(stats.turns).toBe(3);
    expect(stats.assistantMessages).toBe(2);
  });

  it("counts tool uses in assistant content blocks", async () => {
    const { parseJsonlStats } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);

    expect(stats.toolUses).toBe(3);
  });

  it("determines primary model from mixed-model conversation", async () => {
    const { parseJsonlStats } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);

    expect(stats.model).toBe("claude-sonnet-4-6-20250514");
  });

  it("computes duration from first/last timestamp", async () => {
    const { parseJsonlStats } = loadParseJsonlStats();
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

    const stats = await parseJsonlStats(filePath);

    // 10 minutes = 600,000 ms
    expect(stats.durationMs).toBe(600_000);
  });

  it("handles empty JSONL gracefully", async () => {
    const { parseJsonlStats } = loadParseJsonlStats();
    const filePath = path.join(TMP_DIR, "empty.jsonl");
    fs.writeFileSync(filePath, "");

    const stats = await parseJsonlStats(filePath);

    expect(stats.tokens.input).toBe(0);
    expect(stats.tokens.output).toBe(0);
    expect(stats.turns).toBe(0);
    expect(stats.assistantMessages).toBe(0);
    expect(stats.toolUses).toBe(0);
    expect(stats.durationMs).toBe(0);
    expect(stats.model).toBe(null);
    expect(stats.estimatedCostUSD).toBe(0);
  });

  it("handles corrupt lines gracefully (skips them)", async () => {
    const { parseJsonlStats } = loadParseJsonlStats();
    const filePath = path.join(TMP_DIR, "corrupt.jsonl");
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

    const stats = await parseJsonlStats(filePath);

    // Should have parsed the valid lines, skipping corrupt ones
    expect(stats.turns).toBe(1);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.tokens.input).toBe(50);
    expect(stats.tokens.output).toBe(25);
  });
});

describe("findChildSessionIds", () => {
  it("finds direct children in a session graph", () => {
    const { findChildSessionIds } = loadParseJsonlStats();
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
    const { findChildSessionIds } = loadParseJsonlStats();
    const graph = {
      "child-1": { parentSessionId: "other-parent" },
    };

    expect(findChildSessionIds("no-children", graph)).toEqual([]);
  });
});

describe("findAllDescendants", () => {
  it("finds all descendants recursively", () => {
    const { findAllDescendants } = loadParseJsonlStats();
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
    const { findAllDescendants } = loadParseJsonlStats();
    const graph = {
      "child-1": { parentSessionId: "root" },
    };

    expect(findAllDescendants("child-1", graph)).toEqual([]);
  });
});

describe("getPricing", () => {
  it("matches partial model names with date suffix", () => {
    const { getPricing, PRICING } = loadParseJsonlStats();

    expect(getPricing("claude-sonnet-4-6-20250514")).toBe(
      PRICING["claude-sonnet-4-6"],
    );
    expect(getPricing("claude-opus-4-6")).toBe(PRICING["claude-opus-4-6"]);
  });

  it("returns default (Sonnet) pricing for unknown models", () => {
    const { getPricing, PRICING } = loadParseJsonlStats();

    expect(getPricing("unknown-model")).toBe(PRICING["claude-sonnet-4-6"]);
    expect(getPricing(null)).toBe(PRICING["claude-sonnet-4-6"]);
  });
});
