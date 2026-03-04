/**
 * Sort sessions into display order: recent → processing → fresh → dead.
 * Recent (idle + offloaded) sorted by most recently used first, capped at 10.
 * Processing sorted by lowest PID (longest running first).
 */
function sortSessions(sessions) {
  const recent = sessions.filter(
    (s) => s.status === "idle" || s.status === "offloaded",
  );
  const processing = sessions.filter((s) => s.status === "processing");
  const fresh = sessions.filter((s) => s.status === "fresh");
  const dead = sessions.filter((s) => s.status === "dead");

  // Recent: most recently used first (highest idleTs)
  recent.sort((a, b) => b.idleTs - a.idleTs);
  // Processing: longest running on top (lowest PID = oldest process)
  processing.sort((a, b) => Number(a.pid) - Number(b.pid));

  return [...recent.slice(0, 10), ...processing, ...fresh, ...dead];
}

module.exports = { sortSessions };
