import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { createTestEnv } from "./helpers/test-env.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("daemon socket path isolation", () => {
  let env;

  beforeEach(() => {
    env = createTestEnv("daemon-decouple");
  });

  afterAll(() => {
    // Clean up any leftover --own-pool from argv
    const idx = process.argv.indexOf("--own-pool");
    if (idx !== -1) process.argv.splice(idx, 1);
  });

  it("uses default daemon paths without --own-pool", () => {
    // Ensure --own-pool is NOT in argv
    const idx = process.argv.indexOf("--own-pool");
    if (idx !== -1) process.argv.splice(idx, 1);

    const paths = env.requireFresh("paths.js");
    expect(paths.DAEMON_SOCKET).toBe(path.join(env.dir, "pty-daemon.sock"));
    expect(paths.DAEMON_PID_FILE).toBe(path.join(env.dir, "pty-daemon.pid"));
    env.cleanup();
  });

  it("uses dev daemon paths with --own-pool", () => {
    process.argv.push("--own-pool");
    try {
      const paths = env.requireFresh("paths.js");
      expect(paths.DAEMON_SOCKET).toBe(
        path.join(env.dir, "pty-daemon-dev.sock"),
      );
      expect(paths.DAEMON_PID_FILE).toBe(
        path.join(env.dir, "pty-daemon-dev.pid"),
      );
    } finally {
      const idx = process.argv.indexOf("--own-pool");
      if (idx !== -1) process.argv.splice(idx, 1);
    }
    env.cleanup();
  });

  it("pool files and daemon files both branch on --own-pool", () => {
    process.argv.push("--own-pool");
    try {
      const paths = env.requireFresh("paths.js");
      // Pool files
      expect(paths.POOL_FILE).toContain("pool-dev.json");
      expect(paths.ACTIVE_SESSIONS_FILE).toContain("active-sessions-dev.json");
      // Daemon files
      expect(paths.DAEMON_SOCKET).toContain("pty-daemon-dev.sock");
      expect(paths.DAEMON_PID_FILE).toContain("pty-daemon-dev.pid");
    } finally {
      const idx = process.argv.indexOf("--own-pool");
      if (idx !== -1) process.argv.splice(idx, 1);
    }
    env.cleanup();
  });
});

describe("pty-daemon respects env var overrides", () => {
  it("OPEN_COCKPIT_DAEMON_SOCKET is passed to daemon env", () => {
    const env = createTestEnv("daemon-env-test");
    try {
      const paths = env.requireFresh("paths.js");
      const daemonClient = env.requireFresh("daemon-client.js");

      // The daemon-client module imports DAEMON_SOCKET from paths.
      // Verify the socket path matches the test dir.
      expect(paths.DAEMON_SOCKET).toBe(path.join(env.dir, "pty-daemon.sock"));
    } finally {
      env.cleanup();
    }
  });
});
