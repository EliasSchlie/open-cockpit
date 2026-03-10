import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { createTestEnv } from "./helpers/test-env.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Check if node-pty is available (may be compiled for Electron's Node ABI)
let ptyAvailable = true;
try {
  require("node-pty");
} catch {
  ptyAvailable = false;
}

let env;
let daemonClient;
let paths;
let daemonPid = null;

describe.skipIf(!ptyAvailable)("daemon-client integration", () => {
  beforeAll(async () => {
    env = createTestEnv("daemon-test");
    paths = env.requireFresh("paths.js");
    daemonClient = env.requireFresh("daemon-client.js");
    daemonClient.init({ onPtyEvent: () => {}, debugLog: () => {} });
  }, 15000);

  afterAll(async () => {
    // Suppress unhandled rejections from pending daemon requests during teardown
    const suppress = (e) => {
      if (e?.message?.includes("Daemon disconnected")) return;
      if (e?.message?.includes("Daemon request timeout")) return;
      throw e;
    };
    process.on("unhandledRejection", suppress);

    // Destroy the client socket first
    try {
      daemonClient.destroySocket();
    } catch {
      // Ignore
    }

    // Kill the daemon process
    const pid =
      daemonPid ||
      (() => {
        try {
          return parseInt(
            fs.readFileSync(env.resolve("pty-daemon.pid"), "utf-8").trim(),
            10,
          );
        } catch {
          return null;
        }
      })();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead
      }
    }

    // Wait for daemon cleanup + pending rejections to fire
    await new Promise((r) => setTimeout(r, 300));
    process.removeListener("unhandledRejection", suppress);
    env.cleanup();
  }, 10000);

  it("starts daemon and creates PID file", async () => {
    await daemonClient.ensureDaemon();

    const pidFile = env.resolve("pty-daemon.pid");
    expect(fs.existsSync(pidFile)).toBe(true);

    daemonPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    expect(daemonPid).toBeGreaterThan(0);

    // Verify daemon process is alive
    let alive = false;
    try {
      process.kill(daemonPid, 0);
      alive = true;
    } catch {
      // not alive
    }
    expect(alive).toBe(true);
  }, 10000);

  let spawnedTermId;

  it("spawns a terminal", async () => {
    const result = await daemonClient.daemonRequest({
      type: "spawn",
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      cwd: env.dir,
    });

    expect(result.type).toBe("spawned");
    expect(result.termId).toBeGreaterThan(0);
    expect(result.pid).toBeGreaterThan(0);
    spawnedTermId = result.termId;
  }, 10000);

  it("lists terminals including the spawned one", async () => {
    const result = await daemonClient.daemonRequest({ type: "list" });

    expect(result.type).toBe("list-result");
    expect(Array.isArray(result.ptys)).toBe(true);

    const found = result.ptys.find((p) => p.termId === spawnedTermId);
    expect(found).toBeDefined();
    expect(found.pid).toBeGreaterThan(0);
    expect(found.cols).toBe(80);
    expect(found.rows).toBe(24);
  }, 10000);

  it("writes to terminal (fire-and-forget)", async () => {
    // write is fire-and-forget — daemon doesn't send a response for writes.
    // Use daemonSend (not daemonRequest) to avoid a dangling pending promise.
    daemonClient.daemonSend({
      type: "write",
      termId: spawnedTermId,
      data: "echo hello-daemon-test\n",
    });

    // Give shell time to process the command
    await new Promise((r) => setTimeout(r, 500));
  }, 10000);

  it("reads buffer with content", async () => {
    const result = await daemonClient.daemonRequest({
      type: "read-buffer",
      termId: spawnedTermId,
    });

    expect(result.type).toBe("read-buffer-result");
    expect(result.termId).toBe(spawnedTermId);
    // Buffer should have some content from shell startup + our echo
    expect(result.buffer.length).toBeGreaterThan(0);
  }, 10000);

  it("kills terminal and confirms removal", async () => {
    const killResult = await daemonClient.daemonRequest({
      type: "kill",
      termId: spawnedTermId,
    });

    expect(killResult.type).toBe("killed");
    expect(killResult.termId).toBe(spawnedTermId);

    // Verify terminal is no longer in list
    const listResult = await daemonClient.daemonRequest({ type: "list" });
    const found = listResult.ptys.find((p) => p.termId === spawnedTermId);
    expect(found).toBeUndefined();
  }, 10000);
});
