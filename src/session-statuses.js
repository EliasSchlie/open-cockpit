/**
 * Shared constants for session and pool slot status strings.
 * Import these instead of using raw string literals to catch typos at reference time.
 */

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
  IDLE: "idle",
  BUSY: "busy",
  DEAD: "dead",
  ERROR: "error",
};

const INITIATOR = {
  USER: "user",
  MODEL: "model",
};

module.exports = { STATUS, POOL_STATUS, INITIATOR };
