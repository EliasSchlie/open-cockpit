import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { createApiServer } from "../src/api-server.js";

const TMP_DIR = path.join(os.tmpdir(), "open-cockpit-api-test-" + process.pid);
const SOCKET_PATH = path.join(TMP_DIR, "test-api.sock");

function sendMessage(socketPath, msg) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify(msg) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        sock.destroy();
        resolve(JSON.parse(line));
      }
    });
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout"));
    }, 5000);
  });
}

let server;

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("createApiServer", () => {
  it("responds to ping with pong", async () => {
    server = createApiServer(SOCKET_PATH, {
      ping: async () => ({ type: "pong" }),
    });
    await new Promise((r) => server.on("listening", r));

    const resp = await sendMessage(SOCKET_PATH, { type: "ping", id: 1 });
    expect(resp).toEqual({ type: "pong", id: 1 });
  });

  it("returns error for unknown commands", async () => {
    server = createApiServer(SOCKET_PATH, {});
    await new Promise((r) => server.on("listening", r));

    const resp = await sendMessage(SOCKET_PATH, {
      type: "nonexistent",
      id: 2,
    });
    expect(resp.type).toBe("error");
    expect(resp.id).toBe(2);
    expect(resp.error).toMatch(/Unknown command/);
  });

  it("returns error on handler exception", async () => {
    server = createApiServer(SOCKET_PATH, {
      fail: async () => {
        throw new Error("handler broke");
      },
    });
    await new Promise((r) => server.on("listening", r));

    const resp = await sendMessage(SOCKET_PATH, { type: "fail", id: 3 });
    expect(resp.type).toBe("error");
    expect(resp.id).toBe(3);
    expect(resp.error).toBe("handler broke");
  });

  it("passes message fields to handler", async () => {
    server = createApiServer(SOCKET_PATH, {
      echo: async (msg) => ({ type: "echoed", value: msg.value }),
    });
    await new Promise((r) => server.on("listening", r));

    const resp = await sendMessage(SOCKET_PATH, {
      type: "echo",
      id: 4,
      value: 42,
    });
    expect(resp).toEqual({ type: "echoed", id: 4, value: 42 });
  });

  it("handles multiple messages on same connection", async () => {
    server = createApiServer(SOCKET_PATH, {
      ping: async () => ({ type: "pong" }),
    });
    await new Promise((r) => server.on("listening", r));

    const responses = await new Promise((resolve, reject) => {
      const sock = net.createConnection(SOCKET_PATH);
      let buf = "";
      const results = [];
      sock.on("connect", () => {
        sock.write(JSON.stringify({ type: "ping", id: 1 }) + "\n");
        sock.write(JSON.stringify({ type: "ping", id: 2 }) + "\n");
      });
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          results.push(JSON.parse(buf.slice(0, idx)));
          buf = buf.slice(idx + 1);
        }
        if (results.length >= 2) {
          sock.destroy();
          resolve(results);
        }
      });
      sock.on("error", reject);
      setTimeout(() => {
        sock.destroy();
        reject(new Error("timeout"));
      }, 5000);
    });

    expect(responses).toHaveLength(2);
    expect(responses[0].id).toBe(1);
    expect(responses[1].id).toBe(2);
  });

  it("returns parse error for invalid JSON", async () => {
    server = createApiServer(SOCKET_PATH, {});
    await new Promise((r) => server.on("listening", r));

    const resp = await new Promise((resolve, reject) => {
      const sock = net.createConnection(SOCKET_PATH);
      let buf = "";
      sock.on("connect", () => {
        sock.write("not valid json\n");
      });
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          sock.destroy();
          resolve(JSON.parse(buf.slice(0, idx)));
        }
      });
      sock.on("error", reject);
      setTimeout(() => {
        sock.destroy();
        reject(new Error("timeout"));
      }, 5000);
    });

    expect(resp.type).toBe("error");
    expect(resp.error).toBe("Parse error");
  });

  it("cleans up stale socket file on startup", async () => {
    // Create a stale socket file
    fs.writeFileSync(SOCKET_PATH, "stale");
    server = createApiServer(SOCKET_PATH, {
      ping: async () => ({ type: "pong" }),
    });
    await new Promise((r) => server.on("listening", r));

    const resp = await sendMessage(SOCKET_PATH, { type: "ping", id: 1 });
    expect(resp.type).toBe("pong");
  });

  it("sets socket permissions to 0600", async () => {
    server = createApiServer(SOCKET_PATH, {});
    await new Promise((r) => server.on("listening", r));

    const stats = fs.statSync(SOCKET_PATH);
    // Check owner-only permissions (0600 = rw-------)
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
