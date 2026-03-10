import { describe, it, expect, afterEach, afterAll, beforeEach } from "vitest";
import path from "path";
import { createTestEnv } from "./helpers/test-env.js";

function withOwnPool(fn) {
  process.argv.push("--own-pool");
  try {
    return fn();
  } finally {
    const i = process.argv.indexOf("--own-pool");
    if (i !== -1) process.argv.splice(i, 1);
  }
}

describe("daemon socket path isolation", () => {
  let env;

  beforeEach(() => {
    env = createTestEnv("daemon-decouple");
  });

  afterEach(() => {
    env.cleanup();
  });

  afterAll(() => {
    // Safety net: clean up any leftover --own-pool from argv
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
  });

  it("uses dev daemon paths with --own-pool", () => {
    withOwnPool(() => {
      const paths = env.requireFresh("paths.js");
      expect(paths.DAEMON_SOCKET).toBe(
        path.join(env.dir, "pty-daemon-dev.sock"),
      );
      expect(paths.DAEMON_PID_FILE).toBe(
        path.join(env.dir, "pty-daemon-dev.pid"),
      );
    });
  });

  it("pool files and daemon files both branch on --own-pool", () => {
    withOwnPool(() => {
      const paths = env.requireFresh("paths.js");
      // Pool files
      expect(paths.POOL_FILE).toContain("pool-dev.json");
      expect(paths.ACTIVE_SESSIONS_FILE).toContain("active-sessions-dev.json");
      // Daemon files
      expect(paths.DAEMON_SOCKET).toContain("pty-daemon-dev.sock");
      expect(paths.DAEMON_PID_FILE).toContain("pty-daemon-dev.pid");
    });
  });
});

describe("daemon paths respect OPEN_COCKPIT_TEST_DIR", () => {
  it("daemon socket resolves to test dir", () => {
    const env = createTestEnv("daemon-env-test");
    try {
      const paths = env.requireFresh("paths.js");
      expect(paths.DAEMON_SOCKET).toBe(path.join(env.dir, "pty-daemon.sock"));
      expect(paths.DAEMON_PID_FILE).toBe(path.join(env.dir, "pty-daemon.pid"));
    } finally {
      env.cleanup();
    }
  });
});
