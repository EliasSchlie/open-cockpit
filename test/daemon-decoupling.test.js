import { describe, it, expect, afterEach, beforeEach } from "vitest";
import path from "path";
import os from "os";
import { createTestEnv } from "./helpers/test-env.js";

describe("instance isolation — paths derive from OPEN_COCKPIT_DIR", () => {
  let env;

  beforeEach(() => {
    env = createTestEnv("instance-isolation");
  });

  afterEach(() => {
    env.cleanup();
  });

  it("all paths point to OPEN_COCKPIT_DIR", () => {
    const paths = env.requireFresh("paths.js");
    expect(paths.DAEMON_SOCKET).toBe(path.join(env.dir, "pty-daemon.sock"));
    expect(paths.DAEMON_PID_FILE).toBe(path.join(env.dir, "pty-daemon.pid"));
    expect(paths.POOL_FILE).toBe(path.join(env.dir, "pool.json"));
    expect(paths.API_SOCKET).toBe(path.join(env.dir, "api.sock"));
    expect(paths.ACTIVE_SESSIONS_FILE).toBe(
      path.join(env.dir, "active-sessions.json"),
    );
    expect(paths.PENDING_RESTORE_FILE).toBe(
      path.join(env.dir, "pending-restore.json"),
    );
    expect(paths.POOL_SETTINGS_FILE).toBe(
      path.join(env.dir, "pool-settings.json"),
    );
    expect(paths.SESSION_GRAPH_FILE).toBe(
      path.join(env.dir, "session-graph.json"),
    );
    expect(paths.SESSION_PIDS_DIR).toBe(path.join(env.dir, "session-pids"));
    expect(paths.IDLE_SIGNALS_DIR).toBe(path.join(env.dir, "idle-signals"));
    expect(paths.INTENTIONS_DIR).toBe(path.join(env.dir, "intentions"));
    expect(paths.OFFLOADED_DIR).toBe(path.join(env.dir, "offloaded"));
    expect(paths.DEBUG_LOG_FILE).toBe(path.join(env.dir, "debug.log"));
  });

  it("no -dev suffixed file names", () => {
    const paths = env.requireFresh("paths.js");
    // All paths should use simple names, no branching
    expect(paths.DAEMON_SOCKET).not.toContain("-dev");
    expect(paths.POOL_FILE).not.toContain("-dev");
    expect(paths.API_SOCKET).not.toContain("-dev");
    expect(paths.ACTIVE_SESSIONS_FILE).not.toContain("-dev");
  });

  it("INSTANCE_NAME is null when OPEN_COCKPIT_INSTANCE_NAME not set", () => {
    delete process.env.OPEN_COCKPIT_INSTANCE_NAME;
    const paths = env.requireFresh("paths.js");
    expect(paths.INSTANCE_NAME).toBeNull();
  });

  it("INSTANCE_NAME reflects env var", () => {
    process.env.OPEN_COCKPIT_INSTANCE_NAME = "feature-x";
    try {
      const paths = env.requireFresh("paths.js");
      expect(paths.INSTANCE_NAME).toBe("feature-x");
    } finally {
      delete process.env.OPEN_COCKPIT_INSTANCE_NAME;
    }
  });

  it("defaults to ~/.open-cockpit when no env var set", () => {
    const origDir = process.env.OPEN_COCKPIT_DIR;
    const origTestDir = process.env.OPEN_COCKPIT_TEST_DIR;
    delete process.env.OPEN_COCKPIT_DIR;
    delete process.env.OPEN_COCKPIT_TEST_DIR;
    try {
      const paths = env.requireFresh("paths.js");
      expect(paths.OPEN_COCKPIT_DIR).toBe(
        path.join(os.homedir(), ".open-cockpit"),
      );
    } finally {
      if (origDir !== undefined) process.env.OPEN_COCKPIT_DIR = origDir;
      if (origTestDir !== undefined)
        process.env.OPEN_COCKPIT_TEST_DIR = origTestDir;
    }
  });

  it("OPEN_COCKPIT_DIR takes precedence over OPEN_COCKPIT_TEST_DIR", () => {
    process.env.OPEN_COCKPIT_DIR = "/tmp/oc-dir";
    process.env.OPEN_COCKPIT_TEST_DIR = "/tmp/oc-test-dir";
    try {
      const paths = env.requireFresh("paths.js");
      expect(paths.OPEN_COCKPIT_DIR).toBe("/tmp/oc-dir");
    } finally {
      process.env.OPEN_COCKPIT_DIR = env.dir;
      process.env.OPEN_COCKPIT_TEST_DIR = env.dir;
    }
  });
});
