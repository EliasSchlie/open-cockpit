/**
 * Programmatic API Server — Unix socket API for external process control.
 *
 * Exposes the same operations as the Electron IPC handlers over a
 * newline-delimited JSON protocol on ~/.open-cockpit/api.sock.
 *
 * Protocol: each message is a JSON object with { id, type, ...params }.
 * Responses echo back { id, type: "result"|"error", ... }.
 * Subscribers receive push events as { type: "event", event, data }.
 */

const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

const OPEN_COCKPIT_DIR = path.join(os.homedir(), ".open-cockpit");
const API_SOCKET = path.join(OPEN_COCKPIT_DIR, "api.sock");

/**
 * Start the API socket server.
 * @param {object} handlers - Map of command names to async handler functions
 * @returns {{ server: net.Server, cleanup: () => void, broadcast: (event, data) => void }}
 */
function startApiServer(handlers) {
  fs.mkdirSync(OPEN_COCKPIT_DIR, { recursive: true });

  // Remove stale socket
  try {
    fs.unlinkSync(API_SOCKET);
  } catch {}

  const subscribers = new Set();

  function sendTo(socket, msg) {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + "\n");
    }
  }

  async function handleMessage(socket, msg) {
    const { id, type } = msg;

    if (!type) {
      sendTo(socket, { id, type: "error", error: "missing 'type' field" });
      return;
    }

    if (type === "subscribe") {
      subscribers.add(socket);
      sendTo(socket, { id, type: "result", ok: true });
      return;
    }

    if (type === "ping") {
      sendTo(socket, { id, type: "pong" });
      return;
    }

    const handler = handlers[type];
    if (!handler) {
      sendTo(socket, { id, type: "error", error: `unknown command: ${type}` });
      return;
    }

    try {
      const result = await handler(msg);
      sendTo(socket, { id, type: "result", data: result });
    } catch (err) {
      sendTo(socket, { id, type: "error", error: err.message });
    }
  }

  const server = net.createServer((socket) => {
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
          sendTo(socket, {
            type: "error",
            error: `parse error: ${err.message}`,
          });
        }
      }
    });

    socket.on("close", () => {
      subscribers.delete(socket);
    });

    socket.on("error", () => {
      subscribers.delete(socket);
    });
  });

  server.listen(API_SOCKET, () => {
    fs.chmodSync(API_SOCKET, 0o600);
    console.log(`[api] Listening on ${API_SOCKET}`);
  });

  server.on("error", (err) => {
    console.error("[api] Server error:", err.message);
  });

  function broadcast(event, data) {
    const msg = JSON.stringify({ type: "event", event, data }) + "\n";
    for (const socket of subscribers) {
      if (!socket.destroyed) socket.write(msg);
    }
  }

  function cleanup() {
    server.close();
    try {
      fs.unlinkSync(API_SOCKET);
    } catch {}
  }

  return { server, cleanup, broadcast };
}

module.exports = { startApiServer, API_SOCKET };
