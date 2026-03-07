// Session statistics — on-demand JSONL parsing and cost estimation.
// All computation happens when explicitly requested (no background polling).

const fs = require("fs");
const readline = require("readline");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { findJsonlPath } = require("./session-discovery");
const { readSessionGraph } = require("./pool-manager");
const { CLAUDE_PROJECTS_DIR } = require("./paths");

const execFileAsync = promisify(execFile);

// Pricing per million tokens (USD)
const PRICING = {
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5": {
    input: 0.8,
    output: 4,
    cacheWrite: 1,
    cacheRead: 0.08,
  },
};

// Fallback pricing for unknown models (use Sonnet pricing as reasonable default)
const DEFAULT_PRICING = PRICING["claude-sonnet-4-6"];

function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  // Match partial model names (e.g. "claude-sonnet-4-6-20250514")
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return DEFAULT_PRICING;
}

function estimateCost(tokens, model) {
  const p = getPricing(model);
  const perM = 1_000_000;
  return (
    (tokens.input * p.input) / perM +
    (tokens.output * p.output) / perM +
    (tokens.cacheCreation * p.cacheWrite) / perM +
    (tokens.cacheRead * p.cacheRead) / perM
  );
}

function emptyTokens() {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function addTokens(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

// Parse a JSONL file and extract stats. Reads line-by-line to avoid
// loading the entire file into memory.
async function parseJsonlStats(jsonlPath) {
  const tokens = emptyTokens();
  const modelCounts = new Map();
  let turns = 0;
  let assistantMessages = 0;
  let toolUses = 0;
  let firstTs = null;
  let lastTs = null;

  const stream = fs.createReadStream(jsonlPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Track timestamps
    if (entry.timestamp) {
      const ts = entry.timestamp;
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    if (entry.type === "user") {
      turns++;
    } else if (entry.type === "assistant") {
      assistantMessages++;
      const msg = entry.message;
      if (!msg) continue;

      // Count model usage
      if (msg.model) {
        modelCounts.set(msg.model, (modelCounts.get(msg.model) || 0) + 1);
      }

      // Accumulate tokens
      const u = msg.usage;
      if (u) {
        tokens.input += u.input_tokens || 0;
        tokens.output += u.output_tokens || 0;
        tokens.cacheCreation += u.cache_creation_input_tokens || 0;
        tokens.cacheRead += u.cache_read_input_tokens || 0;
      }

      // Count tool uses
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") toolUses++;
        }
      }
    }
  }

  // Determine primary model (most frequent)
  let model = null;
  let maxCount = 0;
  for (const [m, count] of modelCounts) {
    if (count > maxCount) {
      model = m;
      maxCount = count;
    }
  }

  // Duration in ms
  let durationMs = 0;
  if (firstTs && lastTs) {
    durationMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
  }

  return {
    tokens,
    model,
    turns,
    assistantMessages,
    toolUses,
    durationMs,
    estimatedCostUSD: estimateCost(tokens, model),
  };
}

// Get stats for a single session (without sub-agents)
async function computeSingleSessionStats(sessionId) {
  const jsonlPath = await findJsonlPath(sessionId);
  if (!jsonlPath) {
    return {
      sessionId,
      model: null,
      durationMs: 0,
      turns: 0,
      assistantMessages: 0,
      toolUses: 0,
      tokens: emptyTokens(),
      estimatedCostUSD: 0,
    };
  }

  const stats = await parseJsonlStats(jsonlPath);
  return { sessionId, ...stats };
}

// Find all child session IDs for a given parent (from session graph)
function findChildSessionIds(sessionId, graph) {
  const children = [];
  for (const [childId, entry] of Object.entries(graph)) {
    if (entry.parentSessionId === sessionId) {
      children.push(childId);
    }
  }
  return children;
}

// Recursively find all descendant session IDs
function findAllDescendants(sessionId, graph) {
  const descendants = [];
  const queue = [sessionId];
  while (queue.length > 0) {
    const id = queue.shift();
    const children = findChildSessionIds(id, graph);
    for (const childId of children) {
      descendants.push(childId);
      queue.push(childId);
    }
  }
  return descendants;
}

// Get full stats for a session including all sub-agents
async function getSessionStats(sessionId) {
  const graph = readSessionGraph();

  // Compute stats for the main session
  const mainStats = await computeSingleSessionStats(sessionId);

  // Find and compute sub-agent stats
  const descendantIds = findAllDescendants(sessionId, graph);
  const subAgentStats = await Promise.all(
    descendantIds.map((id) => computeSingleSessionStats(id)),
  );

  // Compute totals (main session + all sub-agents)
  let totalTokens = { ...mainStats.tokens };
  let totalCost = mainStats.estimatedCostUSD;
  let totalTurns = mainStats.turns;

  for (const sub of subAgentStats) {
    totalTokens = addTokens(totalTokens, sub.tokens);
    totalCost += sub.estimatedCostUSD;
    totalTurns += sub.turns;
  }

  return {
    ...mainStats,
    subAgents: subAgentStats,
    totalWithSubAgents: {
      tokens: totalTokens,
      estimatedCostUSD: totalCost,
      turns: totalTurns,
    },
  };
}

// Get aggregate stats across all sessions that have JSONL files
async function getAllSessionStats() {
  // Use `find` for fast JSONL discovery (same pattern as session-discovery.js)
  let jsonlFiles = [];
  try {
    const { stdout } = await execFileAsync(
      "find",
      [CLAUDE_PROJECTS_DIR, "-name", "*.jsonl", "-maxdepth", "4"],
      { encoding: "utf-8", timeout: 10000 },
    );
    jsonlFiles = stdout.split("\n").filter(Boolean);
  } catch {
    // Directory may not exist
  }

  let totalTokens = emptyTokens();
  let totalCost = 0;
  let totalTurns = 0;
  let totalAssistant = 0;
  let totalToolUses = 0;
  let sessionCount = 0;
  const modelCounts = new Map();

  // Parse all JSONL files in parallel (batched to avoid fd exhaustion)
  const BATCH_SIZE = 20;
  for (let i = 0; i < jsonlFiles.length; i += BATCH_SIZE) {
    const batch = jsonlFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          return await parseJsonlStats(file);
        } catch {
          return null;
        }
      }),
    );

    for (const stats of results) {
      if (!stats) continue;
      sessionCount++;
      totalTokens = addTokens(totalTokens, stats.tokens);
      totalCost += stats.estimatedCostUSD;
      totalTurns += stats.turns;
      totalAssistant += stats.assistantMessages;
      totalToolUses += stats.toolUses;
      if (stats.model) {
        modelCounts.set(
          stats.model,
          (modelCounts.get(stats.model) || 0) + stats.assistantMessages,
        );
      }
    }
  }

  // Sort models by usage
  const topModels = [...modelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, count]) => ({ model, count }));

  return {
    sessionCount,
    tokens: totalTokens,
    estimatedCostUSD: totalCost,
    turns: totalTurns,
    assistantMessages: totalAssistant,
    toolUses: totalToolUses,
    topModels,
  };
}

module.exports = {
  getSessionStats,
  getAllSessionStats,
  PRICING,
};
