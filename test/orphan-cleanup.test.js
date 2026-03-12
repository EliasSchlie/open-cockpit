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
let POOL_SPAWNED_PIDS_DIR;

let killCalls;
const realProcessKill = process.kill.bind(process);

const uuid = () => crypto.randomUUID();

beforeAll(() => {
  env = createTestEnv("orphan-cleanup-test");
  SESSION_PIDS_DIR = env.resolve("session-pids");
  OFFLOADED_DIR = env.resolve("offloaded");
  IDLE_SIGNALS_DIR = env.resolve("idle-signals");
  POOL_SPAWNED_PIDS_DIR = env.resolve("pool-spawned-pids");
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
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGTERM") {
      killCalls.push(pid);
      return true;
    }
    return realProcessKill(pid, signal);
  });
  // Clean test dirs
  for (const dir of [
    SESSION_PIDS_DIR,
    IDLE_SIGNALS_DIR,
    OFFLOADED_DIR,
    POOL_SPAWNED_PIDS_DIR,
  ]) {
    for (const f of fs.readdirSync(dir).filter((f) => !f.startsWith("."))) {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    }
  }
});

function writePidFile(pid, sessionId) {
  fs.writeFileSync(path.join(SESSION_PIDS_DIR, String(pid)), sessionId);
}

function writeSpawnedPid(pid) {
  fs.writeFileSync(path.join(POOL_SPAWNED_PIDS_DIR, String(pid)), "");
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

function spawnedPidExists(pid) {
  return fs.existsSync(path.join(POOL_SPAWNED_PIDS_DIR, String(pid)));
}

const ALIVE_PID = process.pid;
const DEAD_PID = 2147483647;

describe("cleanupOrphanedProcesses", () => {
  it("cleans up dead spawned PID entries", async () => {
    writeSpawnedPid(DEAD_PID);
    writePidFile(DEAD_PID, uuid());

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map());

    expect(spawnedPidExists(DEAD_PID)).toBe(false);
    expect(pidFileExists(DEAD_PID)).toBe(false);
    expect(killCalls).toEqual([]);
  });

  it("skips PIDs tracked by pool slots", async () => {
    writeSpawnedPid(ALIVE_PID);
    writePidFile(ALIVE_PID, uuid());

    await poolManager.cleanupOrphanedProcesses(
      { slots: [{ pid: ALIVE_PID }] },
      new Map(),
    );

    expect(spawnedPidExists(ALIVE_PID)).toBe(true);
    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("skips PIDs tracked by daemon PTYs", async () => {
    writeSpawnedPid(ALIVE_PID);
    writePidFile(ALIVE_PID, uuid());

    await poolManager.cleanupOrphanedProcesses(
      { slots: [] },
      new Map([["term-1", { pid: ALIVE_PID }]]),
    );

    expect(spawnedPidExists(ALIVE_PID)).toBe(true);
    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("skips spawned PIDs with offload metadata", async () => {
    const sid = uuid();
    writeSpawnedPid(ALIVE_PID);
    writePidFile(ALIVE_PID, sid);
    writeOffloadMeta(sid);

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map());

    expect(spawnedPidExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("never kills processes not in pool-spawned-pids (even if in session-pids)", async () => {
    writePidFile(ALIVE_PID, uuid());
    // No writeSpawnedPid — this process wasn't spawned by us

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map());

    expect(pidFileExists(ALIVE_PID)).toBe(true);
    expect(killCalls).toEqual([]);
  });

  it("kills orphaned spawned process not tracked by any slot", async () => {
    writeSpawnedPid(ALIVE_PID);
    writePidFile(ALIVE_PID, uuid());

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map());

    expect(killCalls).toEqual([ALIVE_PID]);
    expect(spawnedPidExists(ALIVE_PID)).toBe(false);
    expect(pidFileExists(ALIVE_PID)).toBe(false);
  });

  it("kills orphaned spawned process even without session-pids entry", async () => {
    writeSpawnedPid(ALIVE_PID);
    // No writePidFile — session-pids entry missing (hooks didn't fire)

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map());

    expect(killCalls).toEqual([ALIVE_PID]);
    expect(spawnedPidExists(ALIVE_PID)).toBe(false);
  });

  it("handles missing pool-spawned-pids directory gracefully", async () => {
    fs.rmSync(POOL_SPAWNED_PIDS_DIR, { recursive: true });

    await poolManager.cleanupOrphanedProcesses({ slots: [] }, new Map());

    expect(killCalls).toEqual([]);

    fs.mkdirSync(POOL_SPAWNED_PIDS_DIR, { recursive: true });
  });
});
