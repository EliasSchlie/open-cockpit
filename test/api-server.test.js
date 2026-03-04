import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";

const TMP_DIR = path.join(os.tmpdir(), "open-cockpit-api-test-" + process.pid);
const TEST_SOCKET = path.join(TMP_DIR, "test-api.sock");

let apiInstance;

function sendRequest(msg) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(TEST_SOCKET);
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify(msg) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        sock.end();
        resolve(JSON.parse(line));
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000);
  });
}

function startApiServerAt(socketPath, handlers) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.unlinkSync(socketPath);
  } catch {}

  const subscribers = new Set();
  function sendTo(socket, msg) {
    if (!socket.destroyed) socket.write(JSON.stringify(msg) + "\n");
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
    socket.on("close", () => subscribers.delete(socket));
    socket.on("error", () => subscribers.delete(socket));
  });

  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
  });

  function cleanup() {
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  }

  return { server, cleanup };
}

beforeEach(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  apiInstance = startApiServerAt(TEST_SOCKET, {
    echo: (msg) => ({ echoed: msg.value }),
    failing: () => {
      throw new Error("test failure");
    },
    async: async () => ({ delayed: true }),
  });
  await new Promise((resolve) => {
    const check = () => {
      if (fs.existsSync(TEST_SOCKET)) return resolve();
      setTimeout(check, 50);
    };
    check();
  });
});

afterEach(() => {
  if (apiInstance) apiInstance.cleanup();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("API Server", () => {
  it("responds to ping with pong", async () => {
    const resp = await sendRequest({ id: 1, type: "ping" });
    expect(resp.type).toBe("pong");
    expect(resp.id).toBe(1);
  });

  it("routes to registered handler", async () => {
    const resp = await sendRequest({ id: 2, type: "echo", value: "hello" });
    expect(resp.type).toBe("result");
    expect(resp.data).toEqual({ echoed: "hello" });
  });

  it("returns error for unknown command", async () => {
    const resp = await sendRequest({ id: 3, type: "nonexistent" });
    expect(resp.type).toBe("error");
    expect(resp.error).toMatch(/unknown command/);
  });

  it("returns error when handler throws", async () => {
    const resp = await sendRequest({ id: 4, type: "failing" });
    expect(resp.type).toBe("error");
    expect(resp.error).toBe("test failure");
  });

  it("handles async handlers", async () => {
    const resp = await sendRequest({ id: 5, type: "async" });
    expect(resp.type).toBe("result");
    expect(resp.data).toEqual({ delayed: true });
  });

  it("returns error for missing type", async () => {
    const resp = await sendRequest({ id: 6 });
    expect(resp.type).toBe("error");
    expect(resp.error).toMatch(/missing.*type/);
  });

  it("handles subscribe command", async () => {
    const resp = await sendRequest({ id: 7, type: "subscribe" });
    expect(resp.type).toBe("result");
    expect(resp.ok).toBe(true);
  });

  it("socket file exists after startup", () => {
    expect(fs.existsSync(TEST_SOCKET)).toBe(true);
  });
});
