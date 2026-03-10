// Detect origin from an environment string (env vars separated by spaces or null bytes).
function detectOrigin(envStr) {
  if (/\bOPEN_COCKPIT_POOL=1\b/.test(envStr)) return "pool";
  if (/\bOPEN_COCKPIT_CUSTOM=1\b/.test(envStr)) return "custom";
  if (/\bSUB_CLAUDE=1\b/.test(envStr)) return "sub-claude";
  return "ext";
}

// Extract OPEN_COCKPIT_DIR value from an environment string.
// Returns the dir path or null if not set.
function extractInstanceDir(envStr) {
  const match = envStr.match(/\bOPEN_COCKPIT_DIR=(\S+)/);
  return match ? match[1] : null;
}

// Find the ps output line for a given PID (handles right-aligned PIDs with variable whitespace).
function findPidLine(lines, pid) {
  return lines.find((l) => new RegExp(`^\\s*${pid}\\s`).test(l)) || null;
}

// Parse ps eww output to detect session origins and instance dirs for given PIDs.
function parseOrigins(psOutput, pids) {
  const results = new Map();
  const lines = psOutput.split("\n");
  for (const pid of pids) {
    const pidLine = findPidLine(lines, pid);
    results.set(pid, pidLine ? detectOrigin(pidLine) : "ext");
  }
  return results;
}

// Parse ps eww output to extract OPEN_COCKPIT_DIR for given PIDs.
function parseInstanceDirs(psOutput, pids) {
  const results = new Map();
  const lines = psOutput.split("\n");
  for (const pid of pids) {
    const pidLine = findPidLine(lines, pid);
    results.set(pid, pidLine ? extractInstanceDir(pidLine) : null);
  }
  return results;
}

module.exports = {
  parseOrigins,
  detectOrigin,
  extractInstanceDir,
  parseInstanceDirs,
};
