const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { dialog, shell } = require("electron");
const { secureMkdirSync } = require("./secure-fs");
const { OPEN_COCKPIT_DIR } = require("./paths");
const { resolveClaudePath } = require("./pool-manager");

const INSTALLED_PLUGINS_FILE = path.join(
  os.homedir(),
  ".claude",
  "plugins",
  "installed_plugins.json",
);

function isPluginInstalled() {
  try {
    const plugins = JSON.parse(
      fs.readFileSync(INSTALLED_PLUGINS_FILE, "utf-8"),
    );
    return plugins.some(
      (p) =>
        p.name === "open-cockpit" ||
        (p.package && p.package.includes("open-cockpit")),
    );
  } catch {
    return false;
  }
}

async function checkFirstRun() {
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
        execFileSync(
          claudePath,
          ["plugin", "install", "open-cockpit@elias-tools"],
          {
            encoding: "utf-8",
            timeout: 30000,
          },
        );
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

module.exports = { checkFirstRun };
