const { autoUpdater } = require("electron-updater");
const { IS_DEV } = require("./paths");

const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

let _debugLog = () => {};
let _intervalId = null;
let _send = () => {};

// Exposed state for renderer queries
let _state = {
  status: "idle", // idle | checking | available | downloading | downloaded | error | up-to-date
  version: null,
  progress: null, // { percent, transferred, total }
  error: null,
};

function getState() {
  return { ..._state };
}

function _emit() {
  _send("update-status-changed", _state);
}

function init({ debugLog, send }) {
  _debugLog = debugLog;
  _send = send || (() => {});

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

  autoUpdater.on("checking-for-update", () => {
    _debugLog("auto-updater", "checking for update");
    _state = { status: "checking", version: null, progress: null, error: null };
    _emit();
  });

  autoUpdater.on("update-available", (info) => {
    _debugLog("auto-updater", `update available: v${info.version}`);
    _state = {
      status: "available",
      version: info.version,
      progress: null,
      error: null,
    };
    _emit();
  });

  autoUpdater.on("update-not-available", () => {
    _debugLog("auto-updater", "up to date");
    _state = {
      status: "up-to-date",
      version: null,
      progress: null,
      error: null,
    };
    _emit();
  });

  autoUpdater.on("download-progress", (progress) => {
    _state = {
      status: "downloading",
      version: _state.version,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      },
      error: null,
    };
    _emit();
  });

  autoUpdater.on("update-downloaded", (info) => {
    _debugLog("auto-updater", `update downloaded: v${info.version}`);
    _state = {
      status: "downloaded",
      version: info.version,
      progress: null,
      error: null,
    };
    _emit();
  });

  autoUpdater.on("error", (err) => {
    _debugLog("auto-updater", `error: ${err.message}`);
    _state = {
      status: "error",
      version: _state.version,
      progress: null,
      error: err.message,
    };
    _emit();
  });

  // Initial check on startup
  autoUpdater.checkForUpdates().catch((err) => {
    _debugLog("auto-updater", `initial check failed: ${err.message}`);
  });

  // Periodic checks
  _intervalId = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      _debugLog("auto-updater", `periodic check failed: ${err.message}`);
    });
  }, UPDATE_CHECK_INTERVAL);
}

function checkForUpdates() {
  if (IS_DEV) {
    _state = {
      status: "up-to-date",
      version: null,
      progress: null,
      error: null,
    };
    _emit();
    return Promise.resolve();
  }
  return autoUpdater.checkForUpdates().catch((err) => {
    _debugLog("auto-updater", `manual check failed: ${err.message}`);
    throw err;
  });
}

function downloadUpdate() {
  if (IS_DEV) return Promise.resolve();
  return autoUpdater.downloadUpdate().catch((err) => {
    _debugLog("auto-updater", `download failed: ${err.message}`);
    throw err;
  });
}

function installUpdate() {
  if (IS_DEV) return;
  autoUpdater.quitAndInstall();
}

function destroy() {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}

module.exports = {
  init,
  destroy,
  getState,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
};
