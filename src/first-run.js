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

/** Read the installed_plugins.json entries for our plugin (or null). */
function readPluginEntries() {
  try {
    const data = JSON.parse(fs.readFileSync(INSTALLED_PLUGINS_FILE, "utf-8"));
    const entries = data?.plugins?.[PLUGIN_KEY];
    return Array.isArray(entries) && entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

function isPluginInstalled() {
  return readPluginEntries() !== null;
}

/** Return the installed plugin version string (latest entry), or null. */
function getInstalledPluginVersion() {
  const entries = readPluginEntries();
  if (!entries) return null;
  // Pick the most recently updated entry
  let best = entries[0];
  for (const e of entries) {
    if (e.lastUpdated > best.lastUpdated) best = e;
  }
  return best.version || null;
}

async function checkFirstRun(appVersion) {
  // Ensure ~/.open-cockpit/ exists
  secureMkdirSync(OPEN_COCKPIT_DIR, { recursive: true });

  // Check for claude CLI
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

  // Check for plugin installation
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
    return;
  }

  // Plugin is installed — check if version is outdated
  const installedVersion = getInstalledPluginVersion();
  if (appVersion && installedVersion && installedVersion !== appVersion) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "Plugin Version Mismatch",
      message: `Installed plugin version (${installedVersion}) differs from app version (${appVersion}).`,
      detail:
        "The plugin may update automatically within a few minutes. If you have an active pool, you should destroy and re-initialize it after the plugin updates to pick up new hooks.",
      buttons: ["OK"],
    });
    // Just informational — no action needed from user beyond acknowledgment
  }
}

module.exports = { checkFirstRun, getInstalledPluginVersion };
