const { autoUpdater } = require("electron-updater");
const { INSTANCE_NAME } = require("./paths");
const { UPDATE_STATUS } = require("./session-statuses");

const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
const PROGRESS_THROTTLE_MS = 250;

let _debugLog = () => {};
let _intervalId = null;
let _send = () => {};
let _lastProgressEmit = 0;
let _progressTimer = null;

let _state = {
  status: UPDATE_STATUS.IDLE,
  version: null,
  progress: null,
  error: null,
};

function _setState(overrides) {
  _state = {
    status: UPDATE_STATUS.IDLE,
    version: null,
    progress: null,
    error: null,
    ...overrides,
  };
}

function getState() {
  return {
    ..._state,
    progress: _state.progress ? { ..._state.progress } : null,
  };
}

function _emit() {
  _send("update-status-changed", getState());
}

function _emitThrottled() {
  const now = Date.now();
  if (now - _lastProgressEmit >= PROGRESS_THROTTLE_MS) {
    _lastProgressEmit = now;
    _emit();
  } else if (!_progressTimer) {
    _progressTimer = setTimeout(
      () => {
        _progressTimer = null;
        _lastProgressEmit = Date.now();
        _emit();
      },
      PROGRESS_THROTTLE_MS - (now - _lastProgressEmit),
    );
  }
}

function init({ debugLog, send }) {
  _debugLog = debugLog;
  _send = send || (() => {});

  if (INSTANCE_NAME) {
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
    _setState({ status: UPDATE_STATUS.CHECKING });
    _emit();
  });

  autoUpdater.on("update-available", (info) => {
    _debugLog("auto-updater", `update available: v${info.version}`);
    _setState({ status: UPDATE_STATUS.AVAILABLE, version: info.version });
    _emit();
  });

  autoUpdater.on("update-not-available", () => {
    _debugLog("auto-updater", "up to date");
    _setState({ status: UPDATE_STATUS.UP_TO_DATE });
    _emit();
  });

  autoUpdater.on("download-progress", (progress) => {
    _setState({
      status: UPDATE_STATUS.DOWNLOADING,
      version: _state.version,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
    _emitThrottled();
  });

  autoUpdater.on("update-downloaded", (info) => {
    _debugLog("auto-updater", `update downloaded: v${info.version}`);
    _setState({ status: UPDATE_STATUS.DOWNLOADED, version: info.version });
    _emit();
  });

  autoUpdater.on("error", (err) => {
    _debugLog("auto-updater", `error: ${err.message}`);
    _setState({
      status: UPDATE_STATUS.ERROR,
      version: _state.version,
      error: err.message,
    });
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
  if (INSTANCE_NAME) {
    _setState({ status: UPDATE_STATUS.UP_TO_DATE });
    _emit();
    return Promise.resolve();
  }
  return autoUpdater.checkForUpdates().catch((err) => {
    _debugLog("auto-updater", `manual check failed: ${err.message}`);
    throw err;
  });
}

function downloadUpdate() {
  if (INSTANCE_NAME) return Promise.resolve();
  return autoUpdater.downloadUpdate().catch((err) => {
    _debugLog("auto-updater", `download failed: ${err.message}`);
    throw err;
  });
}

function installUpdate() {
  if (INSTANCE_NAME) return;
  autoUpdater.quitAndInstall();
}

function destroy() {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  if (_progressTimer) {
    clearTimeout(_progressTimer);
    _progressTimer = null;
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
