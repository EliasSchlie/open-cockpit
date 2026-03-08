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

module.exports = { STATUS, POOL_STATUS, INITIATOR, UPDATE_STATUS };
