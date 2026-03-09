const { ORIGIN } = require("./session-statuses");

// Detect origin from an environment string (env vars separated by spaces or null bytes).
function detectOrigin(envStr) {
  // SUB_CLAUDE must be checked first: sub-agents spawned from pool/custom
  // sessions inherit the parent's env vars but should be tagged as sub-claude
  if (/\bSUB_CLAUDE=1\b/.test(envStr)) return ORIGIN.SUB_CLAUDE;
  if (/\bOPEN_COCKPIT_POOL=1\b/.test(envStr)) return ORIGIN.POOL;
  if (/\bOPEN_COCKPIT_CUSTOM=1\b/.test(envStr)) return ORIGIN.CUSTOM;
  return ORIGIN.EXT;
}

// Parse ps eww output to detect session origins for given PIDs.
function parseOrigins(psOutput, pids) {
  const results = new Map();
  const lines = psOutput.split("\n");
  for (const pid of pids) {
    // ps right-aligns PIDs with variable whitespace
    const pidLine = lines.find((l) => new RegExp(`^\\s*${pid}\\s`).test(l));
    results.set(pid, pidLine ? detectOrigin(pidLine) : ORIGIN.EXT);
  }
  return results;
}

module.exports = { parseOrigins, detectOrigin };
