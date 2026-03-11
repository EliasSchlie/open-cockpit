import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let poolManager;
let SESSION_PIDS_DIR;
let OFFLOADED_DIR;
let IDLE_SIGNALS_DIR;

let killCalls;
let originOverrides;
const realProcessKill = process.kill.bind(process);

const uuid = () => crypto.randomUUID();

beforeAll(() => {
  env = createTestEnv("orphan-cleanup-test");
  SESSION_PIDS_DIR = env.resolve("session-pids");
  OFFLOADED_DIR = env.resolve("offloaded");
  IDLE_SIGNALS_DIR = env.resolve("idle-signals");
  poolManager = env.requireFresh("pool-manager.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  env.cleanup();
});

beforeEach(() => {
  killCalls = [];
  originOverrides = new Map();
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGTERM") {
      killCalls.push(pid);
      return true;
    }
    return realProcessKill(pid, signal);
  });
  // Clean test dirs
  for (const dir of [SESSION_PIDS_DIR, IDLE_SIGNALS_DIR, OFFLOADED_DIR]) {
    for (const f of fs.readdirSync(dir).filter((f) => !f.startsWith("."))) {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    }
  }
});

function writePidFile(pid, sessionId) {
  fs.writeFileSync(path.join(SESSION_PIDS_DIR, String(pid)), sessionId);
}

function writeOffloadMeta(sessionId) {
  const dir = path.join(OFFLOADED_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ origin: "pool" }),
  );
}

function pidFileExists(pid) {
  return fs.existsSync(path.join(SESSION_PIDS_DIR, String(pid)));
}

const ALIVE_PID = process.pid;
const DEAD_PID = 2147483647;

describe("cleanupOrphanedProcesses", () => {
  function detectOrigins(pids) {
    const map = new Map();
    for (const pid of pids) {
      map.set(String(pid), originOverrides.get(String(pid)) || "ext");
    }
    return Promise.resolve(map);
  }

  const opts = { _detectOrigins: detectOrigins };

  it("cleans up dead PID files", async () => {
    writePidFile(DEAD_PID, uuid());

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map(), opts);

    expect(pidFileExists(DEAD_PID)).toBe(false);
    expect(killCalls).toEqual([]);
  });

  it("skips PIDs tracked by pool slots", async () => {
    writePidFile(ALIVE_PID, uuid());

    await poolManager.cleanupOrphanedProcesses(
      { slots: [{ pid: ALIVE_PID }] },
      new Map(),
      opts,
    );

    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("skips PIDs tracked by daemon PTYs", async () => {
    writePidFile(ALIVE_PID, uuid());

    await poolManager.cleanupOrphanedProcesses(
      { slots: [] },
      new Map([["term-1", { pid: ALIVE_PID }]]),
      opts,
    );

    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("skips PIDs with offload metadata", async () => {
    const sid = uuid();
    writePidFile(ALIVE_PID, sid);
    writeOffloadMeta(sid);

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map(), opts);

    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("skips alive external sessions (origin=ext)", async () => {
    writePidFile(ALIVE_PID, uuid());
    originOverrides.set(String(ALIVE_PID), "ext");

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map(), opts);

    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("skips alive custom sessions (origin=custom)", async () => {
    writePidFile(ALIVE_PID, uuid());
    originOverrides.set(String(ALIVE_PID), "custom");

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map(), opts);

    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("kills orphaned pool processes not tracked by any slot", async () => {
    writePidFile(ALIVE_PID, uuid());
    originOverrides.set(String(ALIVE_PID), "pool");

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map(), opts);

    expect(killCalls).toEqual([ALIVE_PID]);
    expect(pidFileExists(ALIVE_PID)).toBe(false);
  });

  it("skips PID files with empty session ID", async () => {
    writePidFile(ALIVE_PID, "");

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map(), opts);

    expect(killCalls).toEqual([]);
  });

  it("handles missing session-pids directory gracefully", async () => {
    fs.rmSync(SESSION_PIDS_DIR, { recursive: true });

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map(), opts);

    expect(killCalls).toEqual([]);

    fs.mkdirSync(SESSION_PIDS_DIR, { recursive: true });
  });
});
