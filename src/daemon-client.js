/**
 * Adapter that delegates to ClaudeTermClient, maintaining the same external
 * API surface as the old pty-daemon client.
 *
 * Translates between old pty-daemon message format and claude-term format.
 */
const { ClaudeTermClient } = require("./claude-term-client");

let _client = null;
let _debugLog = () => {};

// Track shell-tab terminals (vs pool sessions)
const knownTermIds = new Set();

function init({ onPtyEvent, debugLog }) {
  if (debugLog) _debugLog = debugLog;

  _client = new ClaudeTermClient({
    onData: (termId, data) => {
      if (onPtyEvent) onPtyEvent({ type: "data", termId, data });
    },
    onReplay: (termId, data) => {
      if (onPtyEvent) onPtyEvent({ type: "replay", termId, data });
    },
    onExit: (termId, exitCode) => {
      knownTermIds.delete(termId);
      if (onPtyEvent) onPtyEvent({ type: "exit", termId, exitCode });
    },
    onLifecycle: (msg) => {
      if (onPtyEvent) onPtyEvent(msg);
    },
    debugLog: _debugLog,
  });
}

function getClient() {
  return _client;
}

function isDaemonRunning() {
  if (!_client) return false;
  return _client.isConnected();
}

async function ensureDaemon() {
  if (!_client) throw new Error("daemon-client not initialized (call init())");
  await _client.ensureConnected();
}

/**
 * Translate and send a message in the old pty-daemon format.
 * Fire-and-forget — no response expected.
 */
function daemonSend(msg) {
  if (!_client) throw new Error("daemon-client not initialized");
  const translated = _translateMessage(msg);
  _client.sendSafe(translated);
}

async function daemonSendSafe(msg) {
  try {
    return daemonSend(msg);
  } catch (err) {
    console.error(
      "daemonSend failed (claude-term may be disconnected):",
      err.message,
    );
    return null;
  }
}

/**
 * Send a request and wait for the translated response.
 */
async function daemonRequest(msg) {
  if (!_client) throw new Error("daemon-client not initialized");
  await ensureDaemon();

  const handler = _getHandler(msg.type);
  return handler(msg);
}

// --- Message translation ---

function _termId(msg) {
  return msg.termId || msg.term_id;
}

function _translateMessage(msg) {
  switch (msg.type) {
    case "write":
      return { type: "write", term_id: _termId(msg), data: msg.data };
    case "resize":
      return {
        type: "resize",
        term_id: _termId(msg),
        cols: msg.cols,
        rows: msg.rows,
      };
    default:
      return msg;
  }
}

function _getHandler(type) {
  switch (type) {
    case "spawn":
      return _handleSpawn;
    case "write":
      return _handleWrite;
    case "resize":
      return _handleResize;
    case "kill":
      return _handleKill;
    case "list":
      return _handleList;
    case "read-buffer":
      return _handleReadBuffer;
    case "attach":
      return _handleAttach;
    case "detach":
      return _handleDetach;
    case "set-session":
      return _handleSetSession;
    case "ping":
      return _handlePing;
    default:
      return async (m) => _client.request(m);
  }
}

async function _handleSpawn(msg) {
  const opts = {};
  if (msg.cmd) opts.cmd = msg.cmd;
  if (msg.args) opts.args = msg.args;
  if (msg.cwd) opts.cwd = msg.cwd;
  if (msg.cols) opts.cols = msg.cols;
  if (msg.rows) opts.rows = msg.rows;
  if (msg.env) opts.env = msg.env;
  if (msg.owner || msg.sessionId) opts.owner = msg.owner || msg.sessionId;

  const { termId, pid } = await _client.spawn(opts);
  knownTermIds.add(termId);
  return { type: "spawned", termId, pid };
}

async function _handleWrite(msg) {
  _client.write(_termId(msg), msg.data);
  return { type: "ok" };
}

async function _handleResize(msg) {
  await _client.resize(_termId(msg), msg.cols, msg.rows);
  return { type: "ok" };
}

async function _handleKill(msg) {
  const tid = _termId(msg);
  knownTermIds.delete(tid);
  await _client.kill(tid);
  return { type: "ok" };
}

async function _handleList(_msg) {
  // List all terminals (not filtered by owner) for OC compatibility.
  // ClaudeTermClient.list() already normalizes field names.
  const terminals = await _client.list(null);
  return { type: "list-result", ptys: terminals };
}

async function _handleReadBuffer(msg) {
  const buffer = await _client.read(_termId(msg));
  return { type: "read-buffer-result", termId: _termId(msg), buffer };
}

async function _handleAttach(msg) {
  await _client.attach(_termId(msg));
  return { type: "attached", termId: _termId(msg) };
}

async function _handleDetach(msg) {
  _client.detach(_termId(msg));
  return { type: "ok" };
}

async function _handleSetSession(msg) {
  await _client.setOwner(_termId(msg), msg.sessionId);
  return { type: "session-set", termId: _termId(msg) };
}

async function _handlePing(_msg) {
  await _client.ping();
  return { type: "pong" };
}

// --- Lifecycle ---

async function stopDaemon() {
  // No-op — we don't own the claude-term daemon
  _debugLog(
    "daemon-client",
    "stopDaemon() is a no-op (claude-term owned externally)",
  );
}

function destroySocket() {
  if (_client) _client.destroy();
}

module.exports = {
  init,
  isDaemonRunning,
  ensureDaemon,
  stopDaemon,
  daemonSend,
  daemonSendSafe,
  daemonRequest,
  destroySocket,
  getClient,
  knownTermIds,
};
