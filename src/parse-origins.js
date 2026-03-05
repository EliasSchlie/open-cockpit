// Parse ps eww output to detect session origins for given PIDs.
function parseOrigins(psOutput, pids) {
  const results = new Map();
  const lines = psOutput.split("\n");
  for (const pid of pids) {
    // ps right-aligns PIDs with variable whitespace
    const pidLine = lines.find((l) => new RegExp(`^\\s*${pid}\\s`).test(l));
    let origin = "ext";
    if (pidLine) {
      if (/\bOPEN_COCKPIT_POOL=1\b/.test(pidLine)) {
        origin = "pool";
      } else if (/\bSUB_CLAUDE=1\b/.test(pidLine)) {
        origin = "sub-claude";
      }
    }
    results.set(pid, origin);
  }
  return results;
}

module.exports = { parseOrigins };
