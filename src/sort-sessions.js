/**
 * Sort sessions into display order: recent → processing → fresh → archived.
 * Recent (idle + offloaded) sorted by most recently used first, capped at 10.
 * Processing sorted by lowest PID (longest running first).
 * Archived sorted by most recently archived first.
 */
function sortSessions(sessions) {
  const recent = sessions.filter(
    (s) => s.status === "idle" || s.status === "offloaded",
  );
  const processing = sessions.filter((s) => s.status === "processing");
  const fresh = sessions.filter((s) => s.status === "fresh");
  const dead = sessions.filter((s) => s.status === "dead");
  const archived = sessions.filter((s) => s.status === "archived");

  // Recent: most recently used first (highest idleTs)
  recent.sort((a, b) => b.idleTs - a.idleTs);
  // Processing: longest running on top (lowest PID = oldest process)
  processing.sort((a, b) => Number(a.pid) - Number(b.pid));
  // Archived: most recently archived first
  archived.sort((a, b) => b.idleTs - a.idleTs);

  return [
    ...recent.slice(0, 10),
    ...processing,
    ...fresh,
    ...dead,
    ...archived,
  ];
}

module.exports = { sortSessions };
