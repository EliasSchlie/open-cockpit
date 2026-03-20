/**
 * Integration tests for the claude-term and claude-pool backend clients.
 *
 * These tests require:
 * - claude-term daemon running (~/.claude-term/daemon.sock)
 * - claude-pool daemon running (~/.claude-pool/default/api.sock)
 *
 * Tests are skipped automatically if the daemons aren't available.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";

const CLAUDE_TERM_SOCKET = path.join(
  os.homedir(),
  ".claude-term",
  "daemon.sock",
);
const CLAUDE_POOL_SOCKET = path.join(
  os.homedir(),
  ".claude-pool",
  "default",
  "api.sock",
);

const termAvailable = fs.existsSync(CLAUDE_TERM_SOCKET);
const poolAvailable = fs.existsSync(CLAUDE_POOL_SOCKET);

/** Send a JSON message to a socket and receive the response */
function socketRequest(socketPath, msg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    let buf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        s.destroy();
        reject(new Error("Timeout"));
      }
    }, timeoutMs);

    s.on("connect", () => {
      s.write(JSON.stringify(msg) + "\n");
    });

    s.on("data", (d) => {
      buf += d.toString();
      const idx = buf.indexOf("\n");
      if (idx !== -1 && !settled) {
        settled = true;
        clearTimeout(timer);
        const line = buf.slice(0, idx);
        s.destroy();
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(new Error(`Bad JSON: ${line}`));
        }
      }
    });

    s.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

describe.skipIf(!termAvailable)("claude-term client integration", () => {
  it("responds to ping", async () => {
    const resp = await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "ping",
      id: "ping1",
    });
    expect(resp.type).toBe("pong");
    expect(resp.id).toBe("ping1");
  });

  it("lists terminals", async () => {
    const resp = await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "list",
      id: "list1",
      owner: "",
    });
    expect(resp.type).toBe("list_result");
    expect(Array.isArray(resp.terminals)).toBe(true);
  });

  it("spawns and kills a terminal", async () => {
    // Spawn
    const spawn = await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "spawn",
      id: "spawn1",
      cwd: os.homedir(),
    });
    expect(spawn.type).toBe("spawned");
    expect(spawn.term_id).toBeTruthy();
    expect(spawn.pid).toBeGreaterThan(0);

    // Verify in list
    const list = await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "list",
      id: "list2",
      owner: "",
    });
    const found = list.terminals.find((t) => t.term_id === spawn.term_id);
    expect(found).toBeTruthy();
    expect(found.alive).toBe(true);

    // Kill
    const kill = await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "kill",
      id: "kill1",
      term_id: spawn.term_id,
    });
    expect(kill.type).toBe("killed");
  });

  it("reads terminal buffer", async () => {
    // Spawn
    const spawn = await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "spawn",
      id: "rd1",
      cwd: os.homedir(),
    });
    // Wait for shell to produce output
    await new Promise((r) => setTimeout(r, 500));

    // Read buffer
    const read = await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "read",
      id: "rd2",
      term_id: spawn.term_id,
    });
    expect(read.type).toBe("read_result");
    // Buffer should be base64 encoded
    expect(typeof read.data).toBe("string");

    // Kill
    await socketRequest(CLAUDE_TERM_SOCKET, {
      type: "kill",
      id: "rd3",
      term_id: spawn.term_id,
    });
  });
});

describe.skipIf(!poolAvailable)("claude-pool client integration", () => {
  it("responds to ping", async () => {
    const resp = await socketRequest(CLAUDE_POOL_SOCKET, {
      type: "ping",
      id: "pp1",
    });
    expect(resp.type).toBe("pong");
  });

  it("returns health", async () => {
    const resp = await socketRequest(CLAUDE_POOL_SOCKET, {
      type: "health",
      id: "h1",
    });
    expect(resp.type).toBe("health");
    // Health data may be nested under resp directly or resp.health
    const h = resp.name ? resp : resp.health || resp;
    expect(typeof h.size).toBe("number");
  });

  it("lists sessions", async () => {
    const resp = await socketRequest(CLAUDE_POOL_SOCKET, {
      type: "ls",
      id: "ls1",
      verbosity: "flat",
    });
    expect(resp.type).toBe("sessions");
    expect(Array.isArray(resp.sessions)).toBe(true);
  });

  it("returns config", async () => {
    const resp = await socketRequest(CLAUDE_POOL_SOCKET, {
      type: "config",
      id: "c1",
    });
    expect(resp.type).toBe("config");
    expect(resp.config).toBeTruthy();
    expect(typeof resp.config.flags).toBe("string");
  });
});

describe("ClaudeTermClient class", () => {
  let ClaudeTermClient;

  beforeAll(async () => {
    const mod = await import("../src/claude-term-client.js");
    ClaudeTermClient = mod.ClaudeTermClient;
  });

  it.skipIf(!termAvailable)("connects and pings", async () => {
    const client = new ClaudeTermClient();
    await client.connect();
    const resp = await client.ping();
    expect(resp.type).toBe("pong");
    client.destroy();
  });

  it.skipIf(!termAvailable)("spawns and kills via client", async () => {
    const client = new ClaudeTermClient();
    await client.connect();

    const { termId, pid } = await client.spawn({ cwd: os.homedir() });
    expect(termId).toBeTruthy();
    expect(pid).toBeGreaterThan(0);

    const terminals = await client.list();
    expect(terminals.some((t) => t.termId === termId)).toBe(true);

    await client.kill(termId);
    client.destroy();
  });

  it.skipIf(!termAvailable)("reads buffer", async () => {
    const client = new ClaudeTermClient();
    await client.connect();

    const { termId } = await client.spawn({ cwd: os.homedir() });
    await new Promise((r) => setTimeout(r, 500));

    const buffer = await client.read(termId);
    expect(typeof buffer).toBe("string");

    await client.kill(termId);
    client.destroy();
  });
});

describe("ClaudePoolClient class", () => {
  let ClaudePoolClient;

  beforeAll(async () => {
    const mod = await import("../src/claude-pool-client.js");
    ClaudePoolClient = mod.ClaudePoolClient;
  });

  it.skipIf(!poolAvailable)("connects and pings", async () => {
    const client = new ClaudePoolClient();
    await client.connect();
    const resp = await client.ping();
    expect(resp.type).toBe("pong");
    client.destroy();
  });

  it.skipIf(!poolAvailable)("gets health", async () => {
    const client = new ClaudePoolClient();
    await client.connect();
    const resp = await client.health();
    expect(resp.type).toBe("health");
    // size may be at resp.size or nested
    const h = resp.size !== undefined ? resp : resp.health || resp;
    expect(typeof h.size).toBe("number");
    client.destroy();
  });

  it.skipIf(!poolAvailable)("lists sessions", async () => {
    const client = new ClaudePoolClient();
    await client.connect();
    const resp = await client.ls({ verbosity: "flat" });
    expect(resp.type).toBe("sessions");
    expect(Array.isArray(resp.sessions)).toBe(true);
    client.destroy();
  });

  it.skipIf(!poolAvailable)("reads config", async () => {
    const client = new ClaudePoolClient();
    await client.connect();
    const resp = await client.config();
    expect(resp.type).toBe("config");
    expect(resp.config).toBeTruthy();
    client.destroy();
  });
});
