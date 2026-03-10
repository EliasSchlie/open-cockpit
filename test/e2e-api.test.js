/**
 * E2E tests for the API server with real session-discovery data.
 * Tests the API protocol over Unix sockets using real (or synthetic) sessions.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "net";
import crypto from "crypto";
import { createTestEnv } from "./helpers/test-env.js";
import {
  spawnTestSession,
  writeIdleSignal,
  writeOffloadMeta,
} from "./helpers/claude-harness.js";
import { createApiServer } from "../src/api-server.js";

let env;
let server;
let socketPath;
const spawnedProcs = [];

/**
 * Send a JSON message to the API socket and return the parsed response.
 */
function sendMessage(sock, msg) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("API message timeout"));
    }, 10_000);
    conn.on("connect", () => {
      conn.write(JSON.stringify(msg) + "\n");
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx);
        clearTimeout(timer);
        conn.destroy();
        resolve(JSON.parse(line));
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

beforeAll(() => {
  env = createTestEnv();
  socketPath = env.resolve("test-api.sock");
});

afterAll(() => {
  for (const proc of spawnedProcs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  if (server) {
    server.close();
    server = null;
  }
  env.cleanup();
});

describe("API E2E", { timeout: 120_000 }, () => {
  it("Test F: get-sessions discovers a live session via API", async () => {
    // Load session-discovery in test env context
    const sd = env.requireFresh("session-discovery.js");
    sd.init({ debugLog: () => {}, onSessionsChanged: () => {} });

    // Build a minimal handler set using session-discovery directly.
    // The full buildApiHandlers() pulls in pool-manager/daemon-client which
    // need a running daemon. We wire just get-sessions manually.
    const handlers = {
      ping: async () => ({ type: "pong" }),
      "get-sessions": async (msg) => {
        const sessions = await sd.getSessions();
        return { type: "sessions", sessions };
      },
    };

    // Start API server
    server = createApiServer(socketPath, handlers);
    await new Promise((resolve, reject) => {
      server.on("listening", resolve);
      server.on("error", reject);
    });

    // Spawn a Claude session
    const session = await spawnTestSession(env, {
      prompt: "Say exactly: api-test",
    });
    spawnedProcs.push(session.process);

    // Invalidate cache so discovery picks up the new PID file
    sd.invalidateSessionsCache();

    // Query via API
    const resp = await sendMessage(socketPath, {
      type: "get-sessions",
      id: 1,
    });

    expect(resp.type).toBe("sessions");
    expect(resp.id).toBe(1);
    expect(Array.isArray(resp.sessions)).toBe(true);

    const found = resp.sessions.find((s) => s.sessionId === session.sessionId);
    expect(found).toBeDefined();
    expect(found.alive).toBe(true);

    // Wait for session to finish cleanly
    await session.waitForExit;
  });

  it("Test G: API operations with synthetic sessions", async () => {
    // Close previous server and create a fresh one with archive handlers
    if (server) {
      server.close();
      server = null;
    }

    const sd = env.requireFresh("session-discovery.js");
    sd.init({ debugLog: () => {}, onSessionsChanged: () => {} });

    const id = crypto.randomUUID();

    // Create an offloaded session
    writeOffloadMeta(env, id, {
      intentionHeading: "API test session",
      archived: false,
    });
    env.writeFile(`offloaded/${id}/snapshot.log`, "snapshot content");

    sd.invalidateSessionsCache();

    socketPath = env.resolve("test-api-g.sock");
    const handlers = {
      ping: async () => ({ type: "pong" }),
      "get-sessions": async () => {
        const sessions = await sd.getSessions();
        return { type: "sessions", sessions };
      },
      "archive-session": async (msg) => {
        writeOffloadMeta(env, msg.sessionId, {
          intentionHeading: "API test session",
          archived: true,
          archivedAt: new Date().toISOString(),
        });
        sd.invalidateSessionsCache();
        return { type: "ok" };
      },
      "unarchive-session": async (msg) => {
        writeOffloadMeta(env, msg.sessionId, {
          intentionHeading: "API test session",
        });
        sd.invalidateSessionsCache();
        return { type: "ok" };
      },
    };
    server = createApiServer(socketPath, handlers);
    await new Promise((resolve, reject) => {
      server.on("listening", resolve);
      server.on("error", reject);
    });

    // Verify session appears as offloaded
    let resp = await sendMessage(socketPath, {
      type: "get-sessions",
      id: 10,
    });
    let sess = resp.sessions.find((s) => s.sessionId === id);
    expect(sess).toBeDefined();
    expect(sess.status).toBe("offloaded");

    // Archive via API
    resp = await sendMessage(socketPath, {
      type: "archive-session",
      id: 11,
      sessionId: id,
    });
    expect(resp.type).toBe("ok");

    // Verify archived
    resp = await sendMessage(socketPath, {
      type: "get-sessions",
      id: 12,
    });
    sess = resp.sessions.find((s) => s.sessionId === id);
    expect(sess).toBeDefined();
    expect(sess.status).toBe("archived");

    // Unarchive via API
    resp = await sendMessage(socketPath, {
      type: "unarchive-session",
      id: 13,
      sessionId: id,
    });
    expect(resp.type).toBe("ok");

    // Verify back to offloaded
    resp = await sendMessage(socketPath, {
      type: "get-sessions",
      id: 14,
    });
    sess = resp.sessions.find((s) => s.sessionId === id);
    expect(sess).toBeDefined();
    expect(sess.status).toBe("offloaded");

    // Ping still works
    resp = await sendMessage(socketPath, { type: "ping", id: 99 });
    expect(resp.type).toBe("pong");
  });
});
