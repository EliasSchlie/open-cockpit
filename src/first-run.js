const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { dialog, shell } = require("electron");
const { secureMkdirSync } = require("./secure-fs");
const { OPEN_COCKPIT_DIR } = require("./paths");
const { resolveClaudePath } = require("./pool-manager");

const PLUGIN_KEY = "open-cockpit@elias-tools";

const INSTALLED_PLUGINS_FILE = path.join(
  os.homedir(),
  ".claude",
  "plugins",
  "installed_plugins.json",
);

const DISMISSED_VERSION_FILE = path.join(
  OPEN_COCKPIT_DIR,
  "dismissed-plugin-version",
);

// --- Cached plugin version with file watching ---
let cachedPluginVersion = null;
let watchStarted = false;

function refreshPluginVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS_FILE, "utf-8"));
    const entries = data?.plugins?.[PLUGIN_KEY];
    if (!Array.isArray(entries) || entries.length === 0) {
      cachedPluginVersion = null;
      return;
    }
    let best = entries[0];
    for (const e of entries) {
      if (e.lastUpdated > best.lastUpdated) best = e;
    }
    cachedPluginVersion = best.version || null;
  } catch {
    cachedPluginVersion = null;
  }
}

function startPluginVersionWatch() {
  if (watchStarted) return;
  watchStarted = true;
  refreshPluginVersion();
  try {
    fs.watchFile(INSTALLED_PLUGINS_FILE, { interval: 10000 }, () => {
      refreshPluginVersion();
    });
  } catch {
    // Non-critical — worst case the cache stays stale until restart
  }
}

function stopPluginVersionWatch() {
  if (!watchStarted) return;
  try {
    fs.unwatchFile(INSTALLED_PLUGINS_FILE);
  } catch {
    // ignore
  }
  watchStarted = false;
}

function getInstalledPluginVersion() {
  if (!watchStarted) refreshPluginVersion();
  return cachedPluginVersion;
}

function isPluginInstalled() {
  if (!watchStarted) refreshPluginVersion();
  return cachedPluginVersion !== null;
}

// --- Dismissed version persistence ---

function getDismissedVersion() {
  try {
    return fs.readFileSync(DISMISSED_VERSION_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function setDismissedVersion(version) {
  try {
    fs.writeFileSync(DISMISSED_VERSION_FILE, version, "utf-8");
  } catch {
    // Non-critical
  }
}

async function checkFirstRun() {
  secureMkdirSync(OPEN_COCKPIT_DIR, { recursive: true });

  let claudePath;
  try {
    claudePath = resolveClaudePath();
  } catch {
    // resolveClaudePath throws if not found
  }

  if (!claudePath) {
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "Claude Code Not Found",
      message: "Claude Code CLI is required but was not found on this system.",
      detail:
        "Open Cockpit requires the Claude Code CLI to function. Please install it first.",
      buttons: ["Open Install Page", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      shell.openExternal(
        "https://docs.anthropic.com/en/docs/claude-code/overview",
      );
    }
    require("electron").app.quit();
    return;
  }

  if (!isPluginInstalled()) {
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: "Plugin Not Installed",
      message: "The Open Cockpit plugin is not installed in Claude Code.",
      detail:
        "The plugin is required for session tracking and idle detection. Install it now?",
      buttons: ["Install Plugin", "Skip"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      try {
        execFileSync(claudePath, ["plugin", "install", PLUGIN_KEY], {
          encoding: "utf-8",
          timeout: 30000,
        });
        refreshPluginVersion();
      } catch (err) {
        await dialog.showMessageBox({
          type: "warning",
          title: "Plugin Installation Failed",
          message: "Could not install the Open Cockpit plugin.",
          detail: err.message,
          buttons: ["OK"],
        });
      }
    }
  }
}

module.exports = {
  checkFirstRun,
  getInstalledPluginVersion,
  getDismissedVersion,
  setDismissedVersion,
  startPluginVersionWatch,
  stopPluginVersionWatch,
};
