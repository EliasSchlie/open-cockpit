const path = require("path");
const os = require("os");

const IS_DEV = process.argv.includes("--dev");
const OWN_POOL = process.argv.includes("--own-pool");
const OPEN_COCKPIT_DIR =
  process.env.OPEN_COCKPIT_TEST_DIR || path.join(os.homedir(), ".open-cockpit");
const INTENTIONS_DIR = path.join(OPEN_COCKPIT_DIR, "intentions");
const COLORS_FILE = path.join(OPEN_COCKPIT_DIR, "colors.json");
const SESSION_PIDS_DIR = path.join(OPEN_COCKPIT_DIR, "session-pids");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DAEMON_SOCKET = path.join(OPEN_COCKPIT_DIR, "pty-daemon.sock");
const DAEMON_SCRIPT = path.join(__dirname, "pty-daemon.js");
const DAEMON_PID_FILE = path.join(OPEN_COCKPIT_DIR, "pty-daemon.pid");
const IDLE_SIGNALS_DIR = path.join(OPEN_COCKPIT_DIR, "idle-signals");
const OFFLOADED_DIR = path.join(OPEN_COCKPIT_DIR, "offloaded");
const POOL_FILE = path.join(
  OPEN_COCKPIT_DIR,
  OWN_POOL ? "pool-dev.json" : "pool.json",
);
const POOL_SETTINGS_FILE = path.join(
  OPEN_COCKPIT_DIR,
  OWN_POOL ? "pool-settings-dev.json" : "pool-settings.json",
);
const SETUP_SCRIPTS_DIR = path.join(OPEN_COCKPIT_DIR, "setup-scripts");
const LAYOUTS_DIR = path.join(OPEN_COCKPIT_DIR, "layouts");
const SESSION_GRAPH_FILE = path.join(OPEN_COCKPIT_DIR, "session-graph.json");
const API_SOCKET = path.join(
  OPEN_COCKPIT_DIR,
  IS_DEV ? "api-dev.sock" : "api.sock",
);
const DEBUG_LOG_FILE = path.join(OPEN_COCKPIT_DIR, "debug.log");
const DEBUG_LOG_MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const DEFAULT_POOL_SIZE = 5;
const ORPHAN_TERMINAL_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function isPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isPidAlive,
  IS_DEV,
  OWN_POOL,
  OPEN_COCKPIT_DIR,
  INTENTIONS_DIR,
  COLORS_FILE,
  SESSION_PIDS_DIR,
  CLAUDE_PROJECTS_DIR,
  DAEMON_SOCKET,
  DAEMON_SCRIPT,
  DAEMON_PID_FILE,
  IDLE_SIGNALS_DIR,
  OFFLOADED_DIR,
  POOL_FILE,
  POOL_SETTINGS_FILE,
  SETUP_SCRIPTS_DIR,
  LAYOUTS_DIR,
  SESSION_GRAPH_FILE,
  API_SOCKET,
  DEBUG_LOG_FILE,
  DEBUG_LOG_MAX_SIZE,
  DEFAULT_POOL_SIZE,
  ORPHAN_TERMINAL_TTL_MS,
};
