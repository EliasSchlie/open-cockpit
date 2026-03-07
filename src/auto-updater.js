const { autoUpdater } = require("electron-updater");
const { dialog } = require("electron");
const { IS_DEV } = require("./paths");

const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

let _debugLog = () => {};
let _intervalId = null;

function init({ debugLog }) {
  _debugLog = debugLog;

  if (IS_DEV) {
    _debugLog("auto-updater", "skipping in dev mode");
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.setFeedURL({
    provider: "github",
    owner: "EliasSchlie",
    repo: "open-cockpit",
  });

  autoUpdater.on("update-available", (info) => {
    _debugLog("auto-updater", `update available: v${info.version}`);
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Available",
        message: `A new version (v${info.version}) is available.`,
        detail: "Would you like to download it now?",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
      });
  });

  autoUpdater.on("update-downloaded", (info) => {
    _debugLog("auto-updater", `update downloaded: v${info.version}`);
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Ready",
        message: `Version ${info.version} has been downloaded.`,
        detail: "Restart now to apply the update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on("error", (err) => {
    _debugLog("auto-updater", `error: ${err.message}`);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    _debugLog("auto-updater", `initial check failed: ${err.message}`);
  });

  _intervalId = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      _debugLog("auto-updater", `periodic check failed: ${err.message}`);
    });
  }, UPDATE_CHECK_INTERVAL);
}

function destroy() {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}

module.exports = { init, destroy };
