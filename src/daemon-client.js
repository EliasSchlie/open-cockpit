const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn: spawnChild } = require("child_process");
const {
  DAEMON_SOCKET,
  DAEMON_SCRIPT,
  DAEMON_PID_FILE,
  OPEN_COCKPIT_DIR,
  isPidAlive,
} = require("./paths");

let daemonSocket = null;
let daemonConnecting = null;
let daemonReqId = 0;
const pendingRequests = new Map();

// Set by init() — called by main.js to forward pty push events
let _onPtyEvent = null;
let _debugLog = () => {};

function init({ onPtyEvent, debugLog }) {
  _onPtyEvent = onPtyEvent;
  if (debugLog) _debugLog = debugLog;
}

function isDaemonRunning() {
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

function getDaemonExecPath() {
  if (process.platform !== "darwin") return process.execPath;
  const link = path.join(os.homedir(), ".open-cockpit", "electron-node");
  try {
    const target = fs.readlinkSync(link);
    if (target === process.execPath) return link;
    fs.unlinkSync(link);
  } catch (e) {
    if (e.code !== "ENOENT")
      _debugLog("electron-node symlink issue:", e.message);
  }
  fs.symlinkSync(process.execPath, link);
  return link;
}

function startDaemon() {
  return new Promise((resolve, reject) => {
    if (isDaemonRunning()) return resolve();
    const child = spawnChild(getDaemonExecPath(), [DAEMON_SCRIPT], {
      detached: true,
      stdio: "ignore",
      cwd: os.homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.unref();
    let attempts = 0;
    const check = () => {
      if (fs.existsSync(DAEMON_SOCKET)) return resolve();
      if (++attempts > 40) return reject(new Error("Daemon failed to start"));
      setTimeout(check, 100);
    };
    setTimeout(check, 50);
  });
}

function handleDaemonMessage(msg) {
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject } = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    if (msg.type === "error") {
      reject(new Error(msg.error || "Daemon error"));
    } else {
      resolve(msg);
    }
    return;
  }
  if (_onPtyEvent) _onPtyEvent(msg);
}

function connectToDaemon() {
  if (daemonSocket && !daemonSocket.destroyed) return Promise.resolve();
  if (daemonConnecting) return daemonConnecting;

  daemonConnecting = new Promise((resolve, reject) => {
    const sock = net.createConnection(DAEMON_SOCKET);
    let buf = "";
    let settled = false;

    sock.on("connect", () => {
      if (settled) return;
      settled = true;
      daemonSocket = sock;
      daemonConnecting = null;
      resolve();
    });

    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          handleDaemonMessage(JSON.parse(line));
        } catch (err) {
          console.error("[main] Daemon parse error:", err.message);
        }
      }
    });

    sock.on("close", () => {
      daemonSocket = null;
      daemonConnecting = null;
      for (const [, { reject: rej }] of pendingRequests) {
        rej(new Error("Daemon disconnected"));
      }
      pendingRequests.clear();
    });

    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        daemonConnecting = null;
        reject(err);
      }
    });
  });

  return daemonConnecting;
}

async function ensureDaemon() {
  if (daemonSocket && !daemonSocket.destroyed) return;
  await startDaemon();
  await connectToDaemon();
}

function daemonSend(msg) {
  if (!daemonSocket || daemonSocket.destroyed) {
    throw new Error("Daemon socket is not connected");
  }
  daemonSocket.write(JSON.stringify(msg) + "\n");
}

async function daemonSendSafe(msg) {
  try {
    return await daemonSend(msg);
  } catch (err) {
    console.error(
      "daemonSend failed (daemon may be disconnected):",
      err.message,
    );
    return null;
  }
}

async function daemonRequest(msg) {
  await ensureDaemon();
  return new Promise((resolve, reject) => {
    const id = ++daemonReqId;
    msg.id = id;
    pendingRequests.set(id, { resolve, reject });
    daemonSend(msg);
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Daemon request timeout"));
      }
    }, 10000);
  });
}

function destroySocket() {
  if (daemonSocket && !daemonSocket.destroyed) {
    daemonSocket.destroy();
  }
}

module.exports = {
  init,
  ensureDaemon,
  daemonSend,
  daemonSendSafe,
  daemonRequest,
  destroySocket,
};
