/**
 * Node.js client for the claude-pool daemon.
 *
 * Speaks newline-delimited JSON over a Unix domain socket.
 * Handles connection lifecycle, request/response matching, event subscriptions,
 * and raw PTY attach sockets.
 */
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn: spawnChild } = require("child_process");
const {
  secureMkdirSync,
  secureWriteFileSync,
  readJsonSync,
} = require("./secure-fs");

const CLAUDE_POOL_HOME =
  process.env.CLAUDE_POOL_HOME || path.join(os.homedir(), ".claude-pool");
const POOLS_REGISTRY = path.join(CLAUDE_POOL_HOME, "pools.json");

class ClaudePoolClient {
  constructor({ poolName, socketPath, onEvent, debugLog } = {}) {
    this._poolName = poolName || "default";
    this._socketPath = socketPath || null; // resolved lazily from registry
    this._onEvent = onEvent || (() => {});
    this._debugLog = debugLog || (() => {});

    this._socket = null;
    this._connecting = null;
    this._reqId = 0;
    this._pending = new Map();
    this._buf = "";
    this._destroyed = false;

    // Active attach sockets: sessionId -> net.Socket
    this._attachSockets = new Map();
  }

  // --- Connection lifecycle ---

  _resolveSocket() {
    if (this._socketPath) return this._socketPath;
    const registry = readJsonSync(POOLS_REGISTRY, {});
    const entry = registry[this._poolName];
    if (entry?.socket) {
      this._socketPath = entry.socket;
      return this._socketPath;
    }
    // Default path
    this._socketPath = path.join(CLAUDE_POOL_HOME, this._poolName, "api.sock");
    return this._socketPath;
  }

  async connect() {
    if (this._socket && !this._socket.destroyed) return;
    if (this._connecting) return this._connecting;

    const sockPath = this._resolveSocket();

    this._connecting = new Promise((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      let settled = false;

      sock.on("connect", () => {
        if (settled) return;
        settled = true;
        this._socket = sock;
        this._connecting = null;
        this._debugLog("claude-pool", `connected to ${this._poolName}`);
        resolve();
      });

      sock.on("data", (chunk) => this._onChunk(chunk));

      sock.on("close", () => {
        this._socket = null;
        this._connecting = null;
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error("claude-pool disconnected"));
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
      // Pool daemon not running — caller should handle init
      throw new Error(
        `claude-pool daemon not running for pool '${this._poolName}'`,
      );
    }
  }

  isConnected() {
    return this._socket && !this._socket.destroyed;
  }

  destroy() {
    this._destroyed = true;
    // Close all attach sockets
    for (const [, sock] of this._attachSockets) {
      sock.destroy();
    }
    this._attachSockets.clear();

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
        this._debugLog("claude-pool", "parse error:", err.message);
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
        reject(new Error(msg.error || "claude-pool error"));
      } else {
        resolve(msg);
      }
      return;
    }

    // Subscription events
    if (msg.type === "event") {
      this._onEvent(msg);
      return;
    }
  }

  _send(msg) {
    if (!this._socket || this._socket.destroyed) {
      throw new Error("claude-pool not connected");
    }
    this._socket.write(JSON.stringify(msg) + "\n");
  }

  sendSafe(msg) {
    try {
      this._send(msg);
    } catch (err) {
      this._debugLog("claude-pool", "sendSafe failed:", err.message);
    }
  }

  async request(msg, timeoutMs = 30000) {
    await this.ensureConnected();
    return new Promise((resolve, reject) => {
      const id = `r${++this._reqId}`;
      msg.id = id;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error("claude-pool request timeout"));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._send(msg);
    });
  }

  // --- Pool lifecycle ---

  /**
   * Initialize the pool. Starts the daemon if needed.
   * Returns health object.
   */
  async init(size, flags) {
    const poolDir = path.join(CLAUDE_POOL_HOME, this._poolName);

    // Write config first
    secureMkdirSync(poolDir, { recursive: true });
    const configPath = path.join(poolDir, "config.json");
    let config = readJsonSync(configPath, {});
    if (size) config.size = size;
    if (flags !== undefined) config.flags = flags;
    secureWriteFileSync(configPath, JSON.stringify(config, null, 2));

    // Start daemon if not running
    if (!this.isConnected()) {
      try {
        await this.connect();
      } catch {
        await this._startDaemon(poolDir);
        await this.connect();
      }
    }

    // Send init
    return this.request(
      {
        type: "init",
        size: size || config.size,
      },
      60000,
    );
  }

  async _startDaemon(poolDir) {
    const bin = this._findDaemonBinary();
    if (!bin) throw new Error("claude-pool daemon binary not found");

    this._debugLog(
      "claude-pool",
      `starting daemon for pool '${this._poolName}'...`,
    );

    const child = spawnChild(bin, ["--pool-dir", poolDir], {
      detached: true,
      stdio: "ignore",
      cwd: os.homedir(),
    });
    child.unref();

    // Wait for socket
    const sockPath = this._resolveSocket();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(sockPath)) {
        // Register in pools.json
        this._registerPool(sockPath);
        this._debugLog("claude-pool", "daemon started");
        return;
      }
    }
    throw new Error("claude-pool daemon failed to start");
  }

  _registerPool(sockPath) {
    let registry = {};
    try {
      registry = JSON.parse(fs.readFileSync(POOLS_REGISTRY, "utf-8"));
    } catch {
      // New registry
    }
    registry[this._poolName] = { socket: sockPath };
    secureMkdirSync(path.dirname(POOLS_REGISTRY), { recursive: true });
    secureWriteFileSync(POOLS_REGISTRY, JSON.stringify(registry, null, 2));
  }

  _findDaemonBinary() {
    const candidates = [
      process.env.CLAUDE_POOL_DAEMON,
      path.join(os.homedir(), ".local", "bin", "claude-pool"),
      "/usr/local/bin/claude-pool",
      "/opt/homebrew/bin/claude-pool",
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

  // --- Pool operations ---

  async health() {
    return this.request({ type: "health" });
  }

  async resize(size) {
    return this.request({ type: "resize", size });
  }

  async config(set) {
    const msg = { type: "config" };
    if (set) msg.set = set;
    return this.request(msg);
  }

  async destroyPool() {
    return this.request({ type: "destroy" }, 60000);
  }

  async ping() {
    return this.request({ type: "ping" });
  }

  // --- Session operations ---

  /** Start a new session. Returns { sessionId, status }. */
  async start({ prompt, parent, metadata } = {}) {
    const msg = { type: "start" };
    if (prompt) msg.prompt = prompt;
    if (parent) msg.parent = parent;
    if (metadata) msg.metadata = metadata;
    return this.request(msg, 60000);
  }

  /** Send a followup prompt to an idle session. */
  async followup(sessionId, prompt) {
    return this.request({ type: "followup", sessionId, prompt }, 60000);
  }

  /** Wait for a session to become idle. Returns output. */
  async wait(sessionId, { timeout, source, turns, detail } = {}) {
    const msg = { type: "wait", sessionId };
    if (timeout) msg.timeout = timeout;
    if (source) msg.source = source;
    if (turns !== undefined) msg.turns = turns;
    if (detail) msg.detail = detail;
    return this.request(msg, (timeout || 300000) + 5000);
  }

  /** Capture session output immediately. */
  async capture(sessionId, { source, turns, detail } = {}) {
    const msg = { type: "capture", sessionId };
    if (source) msg.source = source;
    if (turns !== undefined) msg.turns = turns;
    if (detail) msg.detail = detail;
    return this.request(msg);
  }

  /** Stop/interrupt a session. */
  async stop(sessionId) {
    return this.request({ type: "stop", sessionId });
  }

  /** List sessions. */
  async ls({ parent, statuses, archived, verbosity, tree } = {}) {
    const msg = { type: "ls" };
    if (parent !== undefined) msg.parent = parent;
    if (statuses) msg.statuses = statuses;
    if (archived) msg.archived = archived;
    if (verbosity) msg.verbosity = verbosity;
    if (tree) msg.tree = tree;
    return this.request(msg);
  }

  /** Get full session details. */
  async info(sessionId, verbosity) {
    const msg = { type: "info", sessionId };
    if (verbosity) msg.verbosity = verbosity;
    return this.request(msg);
  }

  /** Archive a session. */
  async archive(sessionId, recursive) {
    const msg = { type: "archive", sessionId };
    if (recursive) msg.recursive = true;
    return this.request(msg, 60000);
  }

  /** Unarchive a session. */
  async unarchive(sessionId) {
    return this.request({ type: "unarchive", sessionId });
  }

  /** Set session properties (priority, pinned, metadata). */
  async set(sessionId, { priority, pinned, metadata } = {}) {
    const msg = { type: "set", sessionId };
    if (priority !== undefined) msg.priority = priority;
    if (pinned !== undefined) msg.pinned = pinned;
    if (metadata) msg.metadata = metadata;
    return this.request(msg);
  }

  // --- Attach (raw PTY I/O) ---

  /**
   * Attach to a session's PTY. Returns a raw byte socket for the terminal.
   * The caller should:
   *   - Read from the socket for terminal output (initial read = replay buffer)
   *   - Write to the socket for terminal input (keystrokes)
   *   - Close the socket to detach
   *
   * @returns {{ socket: net.Socket, cols: number, rows: number }}
   */
  async attachSession(sessionId) {
    const resp = await this.request({ type: "attach", sessionId });
    if (!resp.socketPath) {
      throw new Error("No attach socket returned");
    }

    return new Promise((resolve, reject) => {
      const sock = net.createConnection(resp.socketPath);
      let settled = false;

      sock.on("connect", () => {
        if (settled) return;
        settled = true;
        this._attachSockets.set(sessionId, sock);
        resolve({ socket: sock, cols: resp.cols, rows: resp.rows });
      });

      sock.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      sock.on("close", () => {
        this._attachSockets.delete(sessionId);
      });
    });
  }

  /** Detach from a session. */
  detachSession(sessionId) {
    const sock = this._attachSockets.get(sessionId);
    if (sock) {
      sock.destroy();
      this._attachSockets.delete(sessionId);
    }
  }

  /** Resize a session's PTY. */
  async ptyResize(sessionId, cols, rows) {
    return this.request({ type: "pty-resize", sessionId, cols, rows });
  }

  /** Send raw input to a session's PTY (debug). */
  async input(sessionId, data) {
    return this.request({ type: "input", sessionId, data });
  }

  // --- Debug ---

  /** Get per-slot data (index, pid, pidAlive, sessionId, state). */
  async debugSlots() {
    return this.request({ type: "debug-slots" });
  }

  /** Get raw terminal buffer for a slot by index. */
  async debugCapture(slotIndex, raw) {
    const msg = { type: "debug-capture", slot: slotIndex };
    if (raw) msg.raw = true;
    return this.request(msg);
  }

  // --- Event subscription ---

  async subscribe(filters = {}) {
    const msg = { type: "subscribe", ...filters };
    return this.request(msg);
  }
}

module.exports = { ClaudePoolClient, CLAUDE_POOL_HOME };
