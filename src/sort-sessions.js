const { STATUS } = require("./session-statuses");

/**
 * Sort sessions into display order: typing → recent → processing → fresh → archived.
 * Typing: fresh sessions with editor text (shown first for quick access).
 * Recent (idle + offloaded) sorted by most recently used first, capped at 10.
 * Processing sorted by lowest PID (longest running first).
 * Archived sorted by most recently archived first.
 */
function sortSessions(sessions) {
  const typing = sessions.filter((s) => s.status === STATUS.TYPING);
  const recent = sessions.filter(
    (s) => s.status === STATUS.IDLE || s.status === STATUS.OFFLOADED,
  );
  const processing = sessions.filter((s) => s.status === STATUS.PROCESSING);
  const fresh = sessions.filter((s) => s.status === STATUS.FRESH);
  const dead = sessions.filter((s) => s.status === STATUS.DEAD);
  const archived = sessions.filter((s) => s.status === STATUS.ARCHIVED);

  // Recent: most recently used first (highest idleTs)
  recent.sort((a, b) => b.idleTs - a.idleTs);
  // Processing: longest running on top (lowest PID = oldest process)
  processing.sort((a, b) => Number(a.pid) - Number(b.pid));
  // Archived: most recently archived first
  archived.sort((a, b) => b.idleTs - a.idleTs);

  return [
    ...typing,
    ...recent.slice(0, 10),
    ...processing,
    ...fresh,
    ...dead,
    ...archived,
    ...recent.slice(10),
  ];
}

module.exports = { sortSessions };
