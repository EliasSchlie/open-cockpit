/**
 * Shared constants for session and pool slot status strings.
 * Import these instead of using raw string literals to catch typos at reference time.
 */

const ORIGIN = {
  POOL: "pool",
  CUSTOM: "custom",
  SUB_CLAUDE: "sub-claude",
  EXT: "ext",
};

const STATUS = {
  FRESH: "fresh",
  TYPING: "typing",
  PROCESSING: "processing",
  IDLE: "idle",
  OFFLOADED: "offloaded",
  DEAD: "dead",
  ARCHIVED: "archived",
};

const POOL_STATUS = {
  STARTING: "starting",
  FRESH: "fresh",
  TYPING: "typing",
  IDLE: "idle",
  BUSY: "busy",
  DEAD: "dead",
  ERROR: "error",
};

const INITIATOR = {
  USER: "user",
  MODEL: "model",
};

const UPDATE_STATUS = {
  IDLE: "idle",
  CHECKING: "checking",
  AVAILABLE: "available",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  UP_TO_DATE: "up-to-date",
  ERROR: "error",
};

const PLUGIN_VERSION = {
  NOT_INSTALLED: "not installed",
  UNKNOWN: "unknown",
};

/**
 * Map a live session status to the corresponding pool slot status.
 * Returns null if the session status has no pool equivalent (caller decides fallback).
 */
function sessionToPoolStatus(sessionStatus) {
  switch (sessionStatus) {
    case STATUS.IDLE:
      return POOL_STATUS.IDLE;
    case STATUS.PROCESSING:
      return POOL_STATUS.BUSY;
    case STATUS.FRESH:
      return POOL_STATUS.FRESH;
    case STATUS.TYPING:
      return POOL_STATUS.TYPING;
    default:
      return null;
  }
}

module.exports = {
  STATUS,
  POOL_STATUS,
  INITIATOR,
  ORIGIN,
  UPDATE_STATUS,
  PLUGIN_VERSION,
  sessionToPoolStatus,
};
