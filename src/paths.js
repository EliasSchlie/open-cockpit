const path = require("path");
const os = require("os");

// OPEN_COCKPIT_DIR controls where all state files live.
// Set by --instance flag (via main.js bootstrap) or tests.
// Defaults to ~/.open-cockpit/ for the base instance.
const OPEN_COCKPIT_DIR =
  process.env.OPEN_COCKPIT_DIR ||
  process.env.OPEN_COCKPIT_TEST_DIR || // backwards compat for tests
  path.join(os.homedir(), ".open-cockpit");

// Instance name: set by main.js bootstrap for dev instances. null = base instance.
const INSTANCE_NAME = process.env.OPEN_COCKPIT_INSTANCE_NAME || null;

// All paths derive from OPEN_COCKPIT_DIR — no branching.
const INTENTIONS_DIR = path.join(OPEN_COCKPIT_DIR, "intentions");
const COLORS_FILE = path.join(OPEN_COCKPIT_DIR, "colors.json");
const SESSION_PIDS_DIR = path.join(OPEN_COCKPIT_DIR, "session-pids");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const IDLE_SIGNALS_DIR = path.join(OPEN_COCKPIT_DIR, "idle-signals");
const OFFLOADED_DIR = path.join(OPEN_COCKPIT_DIR, "offloaded");
const AGENTS_DIR = path.join(OPEN_COCKPIT_DIR, "agents");
const SETUP_SCRIPTS_DIR = path.join(OPEN_COCKPIT_DIR, "setup-scripts");
const LAYOUTS_DIR = path.join(OPEN_COCKPIT_DIR, "layouts");
const SESSION_GRAPH_FILE = path.join(OPEN_COCKPIT_DIR, "session-graph.json");
const API_SOCKET = path.join(OPEN_COCKPIT_DIR, "api.sock");
const DEBUG_LOG_FILE = path.join(OPEN_COCKPIT_DIR, "debug.log");
const DEBUG_LOG_MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const DEFAULT_POOL_SIZE = 5;
const PREFERENCES_FILE = path.join(OPEN_COCKPIT_DIR, "preferences.json");

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
  INSTANCE_NAME,
  OPEN_COCKPIT_DIR,
  INTENTIONS_DIR,
  COLORS_FILE,
  SESSION_PIDS_DIR,
  CLAUDE_PROJECTS_DIR,
  IDLE_SIGNALS_DIR,
  OFFLOADED_DIR,
  AGENTS_DIR,
  SETUP_SCRIPTS_DIR,
  LAYOUTS_DIR,
  SESSION_GRAPH_FILE,
  API_SOCKET,
  DEBUG_LOG_FILE,
  DEBUG_LOG_MAX_SIZE,
  DEFAULT_POOL_SIZE,
  PREFERENCES_FILE,
};
