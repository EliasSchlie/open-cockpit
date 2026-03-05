#!/usr/bin/env node
/**
 * PTY Daemon — manages terminal processes independently of any Electron window.
 *
 * Communicates over a Unix domain socket using newline-delimited JSON.
 * Multiple clients (Electron instances) can attach to the same terminals.
 * Terminals survive client disconnects and app restarts.
 *
 * Socket: ~/.open-cockpit/pty-daemon.sock
 */

const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");

const OPEN_COCKPIT_DIR = path.join(os.homedir(), ".open-cockpit");
const SOCKET_PATH = path.join(OPEN_COCKPIT_DIR, "pty-daemon.sock");
const BUFFER_SIZE = 100_000; // bytes of output to buffer per terminal for replay
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // exit after 30 min with no terminals and no clients
const ALLOWED_SHELLS = new Set(["/bin/zsh", "/bin/bash", "/bin/sh"]);
const EXTRA_PATH_DIRS = [
  path.join(os.homedir(), ".claude", "local", "bin"),
  path.join(os.homedir(), ".local", "bin"),
  "/usr/local/bin",
];

function isAllowedCmd(cmd) {
  if (ALLOWED_SHELLS.has(cmd)) return true;
  // Allow absolute paths to existing executables
  if (path.isAbsolute(cmd)) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// --- State ---
let nextTermId = 1;
const terminals = new Map(); // termId -> { proc, meta, chunks, chunksLen, clients: Set<socket> }
const clients = new Set(); // all connected sockets
let idleTimer = null;

// --- Helpers ---

function broadcast(termId, msg) {
  const entry = terminals.get(termId);
  if (!entry) return;
  const line = JSON.stringify(msg) + "\n";
  for (const client of entry.clients) {
    client.write(line);
  }
}

function sendTo(socket, msg) {
  if (!socket.destroyed) {
    socket.write(JSON.stringify(msg) + "\n");
  }
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  // Re-arm only when fully idle (no terminals, no clients)
  if (terminals.size === 0 && clients.size === 0) {
    idleTimer = setTimeout(() => {
      console.log("[pty-daemon] Idle timeout, exiting");
      cleanup();
      process.exit(0);
    }, IDLE_TIMEOUT_MS);
  }
}

function cleanup() {
  for (const [, entry] of terminals) {
    try {
      entry.proc.kill();
    } catch {
      // Process may already be dead — safe to ignore
    }
  }
  terminals.clear();
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[pty-daemon] Failed to remove socket:", err.message);
    }
  }
  try {
    fs.unlinkSync(path.join(OPEN_COCKPIT_DIR, "pty-daemon.pid"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[pty-daemon] Failed to remove PID file:", err.message);
    }
  }
}

// --- Command handlers ---

function handleSpawn(socket, msg) {
  const shell =
    msg.cmd && isAllowedCmd(msg.cmd)
      ? msg.cmd
      : process.env.SHELL || "/bin/zsh";
  const args = msg.args || [];
  const cwd = msg.cwd || os.homedir();
  const termId = nextTermId++;

  // Strip Claude session env vars
  const cleanEnv = { ...process.env, TERM: "xterm-256color" };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_SESSION_ID;
  cleanEnv.PATH = [...EXTRA_PATH_DIRS, process.env.PATH || ""].join(":");

  // Merge caller-provided env overrides (e.g. OPEN_COCKPIT_POOL for origin tagging)
  if (msg.env && typeof msg.env === "object") {
    Object.assign(cleanEnv, msg.env);
  }

  const proc = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: msg.cols || 80,
    rows: msg.rows || 24,
    cwd,
    env: cleanEnv,
  });

  const entry = {
    proc,
    meta: {
      termId,
      sessionId: msg.sessionId || null,
      cwd,
      pid: proc.pid,
      exited: false,
      cols: msg.cols || 80,
      rows: msg.rows || 24,
    },
    chunks: [],
    chunksLen: 0,
    clients: new Set(),
  };
  terminals.set(termId, entry);

  proc.onData((data) => {
    try {
      // Buffer for replay (chunked to avoid O(n) string concat per event)
      entry.chunks.push(data);
      entry.chunksLen += data.length;
      if (entry.chunksLen > BUFFER_SIZE * 2) {
        let joined = entry.chunks.join("").slice(-BUFFER_SIZE);
        // Skip leading UTF-8 continuation bytes (0x80-0xBF) to avoid starting
        // mid-character if the slice split a multi-byte sequence (#90)
        while (
          joined.length > 0 &&
          joined.charCodeAt(0) >= 0x80 &&
          joined.charCodeAt(0) <= 0xbf
        ) {
          joined = joined.slice(1);
        }
        entry.chunks = [joined];
        entry.chunksLen = joined.length;
      }
      broadcast(termId, { type: "data", termId, data });
    } catch (err) {
      console.error(
        `[pty-daemon] onData error (termId=${termId}):`,
        err.message,
      );
    }
  });

  proc.onExit(({ exitCode }) => {
    try {
      entry.meta.exited = true;
      entry.meta.exitCode = exitCode;
      broadcast(termId, { type: "exit", termId, exitCode });
      // Keep the entry around so clients can still see the buffer and exit status.
      // It gets cleaned up when all clients detach or via kill.
      resetIdleTimer();
    } catch (err) {
      console.error(
        `[pty-daemon] onExit error (termId=${termId}):`,
        err.message,
      );
    }
  });

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  sendTo(socket, {
    type: "spawned",
    id: msg.id,
    termId,
    pid: proc.pid,
  });
}

function handleWrite(msg) {
  const entry = terminals.get(msg.termId);
  if (entry && !entry.meta.exited) {
    entry.proc.write(msg.data);
  }
}

function handleResize(msg) {
  const entry = terminals.get(msg.termId);
  if (entry && !entry.meta.exited) {
    entry.proc.resize(msg.cols, msg.rows);
    entry.meta.cols = msg.cols;
    entry.meta.rows = msg.rows;
  }
}

function handleKill(socket, msg) {
  const entry = terminals.get(msg.termId);
  if (entry) {
    if (!entry.meta.exited) {
      try {
        entry.proc.kill();
      } catch {
        // Process may already be dead — safe to ignore
      }
    }
    terminals.delete(msg.termId);
  }
  sendTo(socket, { type: "killed", id: msg.id, termId: msg.termId });
  resetIdleTimer();
}

function handleList(socket, msg) {
  const ptys = [];
  for (const [, entry] of terminals) {
    const buffer = entry.chunks.join("").slice(-BUFFER_SIZE);
    ptys.push({
      ...entry.meta,
      buffer,
      clientCount: entry.clients.size,
    });
  }
  sendTo(socket, { type: "list-result", id: msg.id, ptys });
}

function handleReadBuffer(socket, msg) {
  const entry = terminals.get(msg.termId);
  if (!entry) {
    sendTo(socket, {
      type: "read-buffer-result",
      id: msg.id,
      termId: msg.termId,
      buffer: "",
    });
    return;
  }
  const buffer = entry.chunks.join("").slice(-BUFFER_SIZE);
  sendTo(socket, {
    type: "read-buffer-result",
    id: msg.id,
    termId: msg.termId,
    buffer,
  });
}

function handleAttach(socket, msg) {
  const entry = terminals.get(msg.termId);
  if (!entry) {
    sendTo(socket, {
      type: "attach-error",
      id: msg.id,
      termId: msg.termId,
      error: "not found",
    });
    return;
  }
  entry.clients.add(socket);

  // Send response first (resolves the pending request in main.js)
  sendTo(socket, { type: "attached", id: msg.id, termId: msg.termId });

  // Then replay buffered output (no id — goes through push event path)
  if (entry.chunksLen > 0) {
    const buffer = entry.chunks.join("").slice(-BUFFER_SIZE);
    sendTo(socket, { type: "replay", termId: msg.termId, data: buffer });
  }
  if (entry.meta.exited) {
    sendTo(socket, {
      type: "exit",
      termId: msg.termId,
      exitCode: entry.meta.exitCode,
    });
  }
}

function handleDetach(socket, msg) {
  const entry = terminals.get(msg.termId);
  if (entry) {
    entry.clients.delete(socket);
    // Clean up exited terminals with no attached clients
    if (entry.meta.exited && entry.clients.size === 0) {
      terminals.delete(msg.termId);
      resetIdleTimer();
    }
  }
}

function handleSetSession(socket, msg) {
  const entry = terminals.get(msg.termId);
  if (entry) {
    entry.meta.sessionId = msg.sessionId;
  }
  sendTo(socket, {
    type: "session-set",
    id: msg.id,
    termId: msg.termId,
  });
}

// --- Socket server ---

function handleMessage(socket, msg) {
  switch (msg.type) {
    case "spawn":
      return handleSpawn(socket, msg);
    case "write":
      return handleWrite(msg);
    case "resize":
      return handleResize(msg);
    case "kill":
      return handleKill(socket, msg);
    case "list":
      return handleList(socket, msg);
    case "read-buffer":
      return handleReadBuffer(socket, msg);
    case "attach":
      return handleAttach(socket, msg);
    case "detach":
      return handleDetach(socket, msg);
    case "set-session":
      return handleSetSession(socket, msg);
    case "ping":
      return sendTo(socket, { type: "pong", id: msg.id });
    default:
      sendTo(socket, {
        type: "error",
        id: msg.id,
        error: `unknown command: ${msg.type}`,
      });
  }
}

function startServer() {
  fs.mkdirSync(OPEN_COCKPIT_DIR, { recursive: true });

  // Remove stale socket — ENOENT expected on first run
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[pty-daemon] Failed to remove stale socket:", err.message);
    }
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    resetIdleTimer();

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          handleMessage(socket, JSON.parse(line));
        } catch (err) {
          console.error("[pty-daemon] Parse error:", err.message);
        }
      }
    });

    let disconnected = false;
    function cleanupClient() {
      if (disconnected) return; // guard against double cleanup from close+error
      disconnected = true;
      clients.delete(socket);
      // Remove this socket from all terminal client sets; reap exited terminals
      for (const [termId, entry] of terminals) {
        entry.clients.delete(socket);
        if (entry.meta.exited && entry.clients.size === 0) {
          terminals.delete(termId);
        }
      }
      resetIdleTimer();
    }

    socket.on("close", cleanupClient);

    socket.on("error", (err) => {
      if (err.code !== "ECONNRESET" && err.code !== "EPIPE") {
        console.error("[pty-daemon] Client socket error:", err.message);
      }
      cleanupClient();
    });
  });

  server.listen(SOCKET_PATH, () => {
    // Restrict socket to owner only
    fs.chmodSync(SOCKET_PATH, 0o600);
    console.log(`[pty-daemon] Listening on ${SOCKET_PATH}`);
    // Write PID file so clients can check if daemon is alive
    fs.writeFileSync(
      path.join(OPEN_COCKPIT_DIR, "pty-daemon.pid"),
      String(process.pid),
    );
    resetIdleTimer();
  });

  server.on("error", (err) => {
    console.error("[pty-daemon] Server error:", err);
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}

startServer();
