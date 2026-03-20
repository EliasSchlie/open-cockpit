/**
 * Node.js client for the claude-term daemon.
 *
 * Speaks the same newline-delimited JSON protocol as the Go client.
 * Handles connection lifecycle, request/response matching, push events,
 * and auto-starting the daemon if it's not running.
 */
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn: spawnChild } = require("child_process");

const CLAUDE_TERM_DIR =
  process.env.CLAUDE_TERM_DIR || path.join(os.homedir(), ".claude-term");
const DEFAULT_SOCKET =
  process.env.CLAUDE_TERM_SOCKET || path.join(CLAUDE_TERM_DIR, "daemon.sock");

class ClaudeTermClient {
  constructor({
    socketPath,
    onData,
    onReplay,
    onExit,
    onLifecycle,
    debugLog,
  } = {}) {
    this._socketPath = socketPath || DEFAULT_SOCKET;
    this._onData = onData || (() => {});
    this._onReplay = onReplay || (() => {});
    this._onExit = onExit || (() => {});
    this._onLifecycle = onLifecycle || (() => {});
    this._debugLog = debugLog || (() => {});

    this._socket = null;
    this._connecting = null;
    this._reqId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._buf = "";
    this._destroyed = false;
  }

  // --- Connection lifecycle ---

  async connect() {
    if (this._socket && !this._socket.destroyed) return;
    if (this._connecting) return this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection(this._socketPath);
      let settled = false;

      sock.on("connect", () => {
        if (settled) return;
        settled = true;
        this._socket = sock;
        this._connecting = null;
        this._debugLog("claude-term", "connected");
        resolve();
      });

      sock.on("data", (chunk) => this._onChunk(chunk));

      sock.on("close", () => {
        this._socket = null;
        this._connecting = null;
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error("claude-term disconnected"));
        }
        this._pending.clear();
      });

      sock.on("error", (err) => {
        if (!settled) {
          settled = true;
          this._connecting = null;
          reject(err);
        }
      });
    });

    return this._connecting;
  }

  async ensureConnected() {
    if (this._socket && !this._socket.destroyed) return;
    try {
      await this.connect();
    } catch {
      // Socket doesn't exist or daemon not running — try starting it
      await this._startDaemon();
      await this.connect();
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._socket && !this._socket.destroyed) {
      this._socket.destroy();
    }
    this._socket = null;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client destroyed"));
    }
    this._pending.clear();
  }

  // --- Internal ---

  _onChunk(chunk) {
    this._buf += chunk.toString();
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        this._handleMessage(JSON.parse(line));
      } catch (err) {
        this._debugLog("claude-term", "parse error:", err.message);
      }
    }
  }

  _handleMessage(msg) {
    // Response to a request
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.type === "error") {
        reject(new Error(msg.error || "claude-term error"));
      } else {
        resolve(msg);
      }
      return;
    }

    // Push events
    switch (msg.type) {
      case "data":
        this._onData(msg.term_id, Buffer.from(msg.data, "base64").toString());
        break;
      case "replay":
        this._onReplay(msg.term_id, Buffer.from(msg.data, "base64").toString());
        break;
      case "exit":
        this._onExit(msg.term_id, msg.exit_code);
        break;
      case "term_spawned":
      case "term_killed":
      case "term_exited":
      case "term_owner_changed":
        this._onLifecycle(msg);
        break;
    }
  }

  _send(msg) {
    if (!this._socket || this._socket.destroyed) {
      throw new Error("claude-term not connected");
    }
    this._socket.write(JSON.stringify(msg) + "\n");
  }

  /** Send a fire-and-forget message (no response expected). */
  sendSafe(msg) {
    try {
      this._send(msg);
    } catch (err) {
      this._debugLog("claude-term", "sendSafe failed:", err.message);
    }
  }

  /** Send a request and wait for the response. */
  async request(msg, timeoutMs = 10000) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      const id = `r${++this._reqId}`;
      msg.id = id;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error("claude-term request timeout"));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._send(msg);
    });
  }

  async _startDaemon() {
    // Check if already running
    if (fs.existsSync(this._socketPath)) return;

    this._debugLog("claude-term", "starting daemon...");
    const bin = this._findBinary();
    if (!bin) throw new Error("claude-term binary not found");

    const child = spawnChild(bin, ["start"], {
      detached: true,
      stdio: "ignore",
      cwd: os.homedir(),
    });
    child.unref();

    // Wait for socket to appear
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(this._socketPath)) {
        this._debugLog("claude-term", "daemon started");
        return;
      }
    }
    throw new Error("claude-term daemon failed to start");
  }

  _findBinary() {
    // Check common locations
    const candidates = [
      process.env.CLAUDE_TERM_BIN,
      path.join(os.homedir(), ".local", "bin", "claude-term"),
      "/usr/local/bin/claude-term",
      "/opt/homebrew/bin/claude-term",
    ].filter(Boolean);

    for (const p of candidates) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        continue;
      }
    }
    return null;
  }

  // --- Public API ---

  /** Spawn a new terminal. Returns { term_id, pid }. */
  async spawn({ cmd, args, cwd, cols, rows, env, owner } = {}) {
    const msg = { type: "spawn" };
    if (cmd) msg.cmd = cmd;
    if (args) msg.args = args;
    if (cwd) msg.cwd = cwd;
    if (cols) msg.cols = cols;
    if (rows) msg.rows = rows;
    if (env) msg.env = env;
    if (owner) msg.owner = owner;
    const resp = await this.request(msg);
    return { termId: resp.term_id, pid: resp.pid };
  }

  /** Write data to a terminal (fire-and-forget). */
  write(termId, data) {
    this.sendSafe({ type: "write", term_id: termId, data });
  }

  /** Read the terminal buffer. Returns string. */
  async read(termId) {
    const resp = await this.request({ type: "read", term_id: termId });
    return Buffer.from(resp.data, "base64").toString();
  }

  /** Attach to a terminal (start receiving data/replay/exit events). */
  async attach(termId) {
    return this.request({ type: "attach", term_id: termId });
  }

  /** Detach from a terminal. */
  detach(termId) {
    this.sendSafe({ type: "detach", term_id: termId });
  }

  /** Resize a terminal. */
  async resize(termId, cols, rows) {
    return this.request({ type: "resize", term_id: termId, cols, rows });
  }

  /** Set the owner of a terminal. */
  async setOwner(termId, owner) {
    return this.request({ type: "set_owner", term_id: termId, owner });
  }

  /** Kill a terminal. */
  async kill(termId) {
    return this.request({ type: "kill", term_id: termId });
  }

  /** List terminals. Returns array of terminal info objects. */
  async list(owner) {
    const msg = { type: "list" };
    if (owner) msg.owner = owner;
    const resp = await this.request(msg);
    // Normalize field names for OC compatibility
    return (resp.terminals || []).map((t) => ({
      termId: t.term_id,
      pid: t.pid,
      cmd: t.cmd,
      cwd: t.cwd,
      cols: t.cols,
      rows: t.rows,
      owner: t.owner,
      alive: t.alive,
    }));
  }

  /** Subscribe to lifecycle events. */
  async subscribe() {
    return this.request({ type: "subscribe" });
  }

  /** Health check. */
  async ping() {
    return this.request({ type: "ping" });
  }
}

module.exports = { ClaudeTermClient, CLAUDE_TERM_DIR };
