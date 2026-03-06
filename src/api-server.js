const net = require("net");
const fs = require("fs");

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

function createApiServer(socketPath, handlers, { onListening } = {}) {
  const server = net.createServer((socket) => {
    const chunks = [];
    let chunksLen = 0;
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      chunksLen += chunk.length;
      if (chunksLen > MAX_BUFFER_SIZE) {
        sendTo(socket, {
          type: "error",
          error: "Buffer size limit exceeded",
        });
        socket.destroy();
        return;
      }
      let buf = Buffer.concat(chunks).toString();
      chunks.length = 0;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          handleMessage(socket, JSON.parse(line));
        } catch (err) {
          sendTo(socket, { type: "error", error: "Parse error" });
        }
      }
      if (buf.length > 0) {
        chunks.push(Buffer.from(buf));
        chunksLen = buf.length;
      } else {
        chunksLen = 0;
      }
    });
    socket.on("error", (err) => {
      if (err.code !== "ECONNRESET" && err.code !== "EPIPE") {
        const addr = socket.remoteAddress || "unix";
        console.error(`API socket error [${addr}]:`, err.message);
      }
    });
    socket.on("close", () => {
      chunks.length = 0;
      chunksLen = 0;
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

  // Only replace socket if no live instance is listening on it.
  // Blindly unlinking lets a second instance steal (and then orphan)
  // the socket of a running instance.
  function tryListen() {
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      if (onListening) onListening();
    });
  }

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`API socket ${socketPath} is in use. Skipping API server.`);
    } else {
      console.error("API server error:", err);
    }
  });

  // Probe the socket — connect handles both missing (ENOENT) and stale sockets.
  const probe = new net.Socket();
  probe.setTimeout(2000);
  probe.connect(socketPath, () => {
    // Another instance is alive — don't steal its socket
    probe.destroy();
    console.error(
      `API socket ${socketPath} is in use by another instance. Skipping API server.`,
    );
  });
  probe.on("error", () => {
    // Socket missing or stale — safe to replace
    probe.destroy();
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    tryListen();
  });
  probe.on("timeout", () => {
    // Hung socket — treat as stale
    probe.destroy();
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    tryListen();
  });

  return server;
}

module.exports = { createApiServer };
