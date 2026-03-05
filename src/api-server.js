const net = require("net");
const fs = require("fs");
const log = require("./logger")("api");

function createApiServer(socketPath, handlers) {
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
          log.warn("API parse error", { err: err.message });
          sendTo(socket, { type: "error", error: "Parse error" });
        }
      }
    });
    socket.on("error", (err) => {
      log.warn("API client socket error", { err: err.message });
    });
  });

  async function handleMessage(socket, msg) {
    const handler = handlers[msg.type];
    if (!handler) {
      sendTo(socket, {
        type: "error",
        id: msg.id,
        error: `Unknown command: ${msg.type}`,
      });
      return;
    }
    try {
      const result = await handler(msg);
      sendTo(socket, { ...result, id: msg.id });
    } catch (err) {
      sendTo(socket, { type: "error", id: msg.id, error: err.message });
    }
  }

  function sendTo(socket, msg) {
    if (!socket.destroyed) socket.write(JSON.stringify(msg) + "\n");
  }

  // Clean up stale socket
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.warn("Failed to clean stale API socket", { err: err.message });
    }
  }

  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
  });

  return server;
}

module.exports = { createApiServer };
