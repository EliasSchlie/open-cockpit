/**
 * Structured diagnostic logger for Open Cockpit.
 *
 * Logs anomalies, failures, and state transitions to a persistent log file.
 * Normal operations are NOT logged — only things that help diagnose problems.
 *
 * Usage:
 *   const log = require("./logger")("main");
 *   log.warn("idle signal parse failed", { pid, err: err.message });
 *   log.error("daemon disconnected", { pending: pendingRequests.size });
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const OPEN_COCKPIT_DIR = path.join(os.homedir(), ".open-cockpit");
const LOG_DIR = path.join(OPEN_COCKPIT_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "open-cockpit.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

let fd = null;
let writeCount = 0;
const ROTATION_CHECK_INTERVAL = 500; // check size every N writes

function openLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  rotateIfNeeded();
  fd = fs.openSync(LOG_FILE, "a");
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const rotated = LOG_FILE + ".1";
      try {
        fs.unlinkSync(rotated);
      } catch {}
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch {}
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return "[unserializable]";
  }
}

function write(level, category, message, context) {
  if (fd === null) openLog();
  const ts = new Date().toISOString();
  const ctx = context ? " " + safeStringify(context) : "";
  const line = `${ts} [${level}] [${category}] ${message}${ctx}\n`;
  try {
    fs.writeSync(fd, line);
  } catch {
    // Best-effort — don't crash on log failure
  }
  // Periodically check if rotation is needed
  if (++writeCount % ROTATION_CHECK_INTERVAL === 0) {
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size > MAX_LOG_SIZE) {
        fs.closeSync(fd);
        fd = null;
        openLog();
      }
    } catch {}
  }
}

function createLogger(category) {
  return {
    warn(message, context) {
      write("WARN", category, message, context);
    },
    error(message, context) {
      write("ERROR", category, message, context);
    },
    info(message, context) {
      write("INFO", category, message, context);
    },
  };
}

module.exports = createLogger;
