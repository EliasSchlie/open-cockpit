import { describe, it, expect, afterEach, beforeEach } from "vitest";
import path from "path";
import os from "os";
import { createRequire } from "module";
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

  // Load paths.js with custom env vars, bypassing requireFresh() which
  // always sets OPEN_COCKPIT_DIR to env.dir. Used to test path resolution.
  function loadPathsWithEnv(envOverrides) {
    const req = createRequire(import.meta.url);
    const pathsPath = path.resolve(import.meta.dirname, "../src/paths.js");
    const saved = {};
    for (const [k, v] of Object.entries(envOverrides)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const key of Object.keys(req.cache)) {
      if (key.includes("/src/")) delete req.cache[key];
    }
    try {
      return req(pathsPath);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("defaults to ~/.open-cockpit when no env var set", () => {
    const paths = loadPathsWithEnv({
      OPEN_COCKPIT_DIR: undefined,
      OPEN_COCKPIT_TEST_DIR: undefined,
    });
    expect(paths.OPEN_COCKPIT_DIR).toBe(
      path.join(os.homedir(), ".open-cockpit"),
    );
  });

  it("OPEN_COCKPIT_DIR takes precedence over OPEN_COCKPIT_TEST_DIR", () => {
    const paths = loadPathsWithEnv({
      OPEN_COCKPIT_DIR: "/tmp/oc-dir",
      OPEN_COCKPIT_TEST_DIR: "/tmp/oc-test-dir",
    });
    expect(paths.OPEN_COCKPIT_DIR).toBe("/tmp/oc-dir");
  });
});
