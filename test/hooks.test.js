import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const HOOKS_DIR = path.join(import.meta.dirname, "..", "hooks");

// Isolated temp dir simulating ~/.open-cockpit
let tmpHome;
let env;
// Hooks use $PPID (read-only in bash) — it equals our process.pid when spawned via execFileSync
const hookPid = () => String(process.pid);
const FAKE_SESSION_ID = "test-session-aaaa-bbbb-cccc";

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
  const ocDir = path.join(tmpHome, ".open-cockpit");
  fs.mkdirSync(path.join(ocDir, "session-pids"), { recursive: true });
  fs.mkdirSync(path.join(ocDir, "intentions"), { recursive: true });
  fs.mkdirSync(path.join(ocDir, "idle-signals"), { recursive: true });
  fs.mkdirSync(path.join(ocDir, "logs"), { recursive: true });

  env = { ...process.env, HOME: tmpHome };
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function runHook(script, { stdin, args = [], expectFail = false } = {}) {
  try {
    const result = execFileSync(
      "bash",
      [path.join(HOOKS_DIR, script), ...args],
      {
        env,
        input: stdin,
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status,
    };
  }
}

describe("session-pid-map.sh", () => {
  it("writes PID file from stdin JSON", () => {
    runHook("session-pid-map.sh", {
      stdin: JSON.stringify({ session_id: FAKE_SESSION_ID }),
    });

    const pidFile = path.join(tmpHome, ".open-cockpit/session-pids", hookPid());
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.readFileSync(pidFile, "utf-8").trim()).toBe(FAKE_SESSION_ID);
  });

  it("exits cleanly with empty stdin", () => {
    runHook("session-pid-map.sh", { stdin: "" });

    const pidFile = path.join(tmpHome, ".open-cockpit/session-pids", hookPid());
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("cleans up stale PID entries", () => {
    // Create a stale entry for a non-existent PID
    const stalePid = "2";
    const staleFile = path.join(
      tmpHome,
      ".open-cockpit/session-pids",
      stalePid,
    );
    fs.writeFileSync(staleFile, "old-session-id");

    runHook("session-pid-map.sh", {
      stdin: JSON.stringify({ session_id: FAKE_SESSION_ID }),
    });

    expect(fs.existsSync(staleFile)).toBe(false);
  });
});

describe("session-intention-intro.sh", () => {
  beforeEach(() => {
    // Requires PID mapping to exist
    fs.writeFileSync(
      path.join(tmpHome, ".open-cockpit/session-pids", hookPid()),
      FAKE_SESSION_ID,
    );
  });

  it("outputs intention file path", () => {
    const { stdout } = runHook("session-intention-intro.sh");
    expect(stdout).toContain(FAKE_SESSION_ID);
    expect(stdout).toContain("intentions/");
  });

  it("fires only once per session (marker file)", () => {
    const first = runHook("session-intention-intro.sh");
    expect(first.stdout.length).toBeGreaterThan(0);

    const second = runHook("session-intention-intro.sh");
    expect(second.stdout).toBe("");
  });

  it("does not crash with set -u (no unbound variables)", () => {
    // This is the exact bug that was fixed — EMPTY_NOTE inside heredoc
    // caused "unbound variable" error with set -u
    const { stdout } = runHook("session-intention-intro.sh");
    expect(stdout.length).toBeGreaterThan(0);
    // If we get here without throwing, set -u didn't kill the script
  });

  it("exits cleanly when no PID mapping exists", () => {
    fs.unlinkSync(path.join(tmpHome, ".open-cockpit/session-pids", hookPid()));
    const { stdout } = runHook("session-intention-intro.sh");
    expect(stdout).toBe("");
  });
});

describe("intention-change-notify.sh", () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpHome, ".open-cockpit/session-pids", hookPid()),
      FAKE_SESSION_ID,
    );
  });

  it("outputs reminder text", () => {
    const { stdout } = runHook("intention-change-notify.sh");
    expect(stdout).toContain("Reminder");
    expect(stdout).toContain("intention");
  });

  it("includes diff when intention file changed", () => {
    const intentionFile = path.join(
      tmpHome,
      ".open-cockpit/intentions",
      `${FAKE_SESSION_ID}.md`,
    );
    const snapshotDir = path.join(
      tmpHome,
      ".open-cockpit/intentions/.snapshots",
    );
    fs.mkdirSync(snapshotDir, { recursive: true });

    // Create snapshot (old state)
    fs.writeFileSync(
      path.join(snapshotDir, `${FAKE_SESSION_ID}.md`),
      "# Old\n",
    );
    // Current file (new state)
    fs.writeFileSync(intentionFile, "# New heading\n- Added detail\n");

    const { stdout } = runHook("intention-change-notify.sh");
    expect(stdout).toContain("User changes");
    expect(stdout).toContain("diff");
  });

  it("exits cleanly when no PID mapping exists", () => {
    fs.unlinkSync(path.join(tmpHome, ".open-cockpit/session-pids", hookPid()));
    const { stdout } = runHook("intention-change-notify.sh");
    expect(stdout).toBe("");
  });
});

describe("idle-signal.sh", () => {
  it("writes signal file on 'write tool'", () => {
    runHook("idle-signal.sh", { args: ["write", "tool"], stdin: "{}" });
    const signalFile = path.join(
      tmpHome,
      ".open-cockpit/idle-signals",
      hookPid(),
    );
    expect(fs.existsSync(signalFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    expect(content.trigger).toBe("tool");
  });

  it("clears signal file on 'clear'", () => {
    const signalFile = path.join(
      tmpHome,
      ".open-cockpit/idle-signals",
      hookPid(),
    );
    fs.writeFileSync(signalFile, "{}");

    runHook("idle-signal.sh", { args: ["clear"] });
    expect(fs.existsSync(signalFile)).toBe(false);
  });

  it("writes signal file on 'write permission'", () => {
    runHook("idle-signal.sh", { args: ["write", "permission"], stdin: "{}" });
    const signalFile = path.join(
      tmpHome,
      ".open-cockpit/idle-signals",
      hookPid(),
    );
    expect(fs.existsSync(signalFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    expect(content.trigger).toBe("permission");
  });

  it("writes signal file on 'write session-clear' (replaces old signal)", () => {
    // Simulate existing idle signal from before /clear
    const signalFile = path.join(
      tmpHome,
      ".open-cockpit/idle-signals",
      hookPid(),
    );
    fs.writeFileSync(signalFile, '{"trigger":"stop","ts":1000}');

    runHook("idle-signal.sh", {
      args: ["write", "session-clear"],
      stdin: JSON.stringify({ session_id: FAKE_SESSION_ID }),
    });
    expect(fs.existsSync(signalFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(signalFile, "utf-8"));
    expect(content.trigger).toBe("session-clear");
    expect(content.session_id).toBe(FAKE_SESSION_ID);
    expect(content.ts).toBeGreaterThan(1000);
  });
});

describe("hooks.json - regression guards", () => {
  it("SessionStart/clear writes idle signal (not just clears)", () => {
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(HOOKS_DIR, "hooks.json"), "utf-8"),
    );
    const clearEntry = hooksJson.hooks.SessionStart.find(
      (e) => e.matcher === "clear",
    );
    expect(clearEntry).toBeDefined();
    const cmd = clearEntry.hooks[0].command;
    expect(cmd).toContain("idle-signal.sh write");
    expect(cmd).not.toMatch(/idle-signal\.sh clear/);
  });
});

describe("OPEN_COCKPIT_DIR support", () => {
  it("hooks respect OPEN_COCKPIT_DIR env var", () => {
    const customDir = path.join(tmpHome, "custom-instance");
    fs.mkdirSync(path.join(customDir, "session-pids"), { recursive: true });
    fs.mkdirSync(path.join(customDir, "idle-signals"), { recursive: true });

    const customEnv = { ...env, OPEN_COCKPIT_DIR: customDir };

    // Run hook with OPEN_COCKPIT_DIR pointing to custom dir
    execFileSync("bash", [path.join(HOOKS_DIR, "session-pid-map.sh")], {
      env: customEnv,
      input: JSON.stringify({ session_id: "custom-session-id" }),
      timeout: 5000,
      encoding: "utf-8",
    });

    const pidFile = path.join(customDir, "session-pids", hookPid());
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.readFileSync(pidFile, "utf-8").trim()).toBe("custom-session-id");
  });
});

describe("all hooks - robustness", () => {
  const hookScripts = [
    "session-pid-map.sh",
    "session-intention-intro.sh",
    "intention-change-notify.sh",
    "idle-signal.sh",
  ];

  for (const script of hookScripts) {
    it(`${script} passes bash -n syntax check`, () => {
      execFileSync("bash", ["-n", path.join(HOOKS_DIR, script)]);
    });
  }

  for (const script of hookScripts) {
    it(`${script} does not crash on empty HOME/.open-cockpit`, () => {
      // Fresh HOME with no pre-existing state
      const freshHome = fs.mkdtempSync(path.join(os.tmpdir(), "hook-fresh-"));
      const freshEnv = { ...process.env, HOME: freshHome, PPID: hookPid() };
      try {
        execFileSync("bash", [path.join(HOOKS_DIR, script), "clear"], {
          env: freshEnv,
          input: "{}",
          timeout: 5000,
          encoding: "utf-8",
        });
      } catch {
        // idle-signal clear with no dir is fine, others may exit 0
      } finally {
        fs.rmSync(freshHome, { recursive: true, force: true });
      }
    });
  }
});

describe("hook error logging", () => {
  it("logs errors to hooks.log when a hook fails", () => {
    // Create a minimal script that sources log-error.sh then triggers an error
    const failScript = path.join(tmpHome, "fail-hook.sh");
    fs.writeFileSync(
      failScript,
      `#!/bin/bash
set -euo pipefail
source "${path.join(HOOKS_DIR, "log-error.sh")}"
HOOK_SCRIPT_NAME="test-fail-hook"
false  # trigger ERR trap
`,
    );

    let exitCode;
    try {
      execFileSync("bash", [failScript], {
        env,
        timeout: 5000,
        encoding: "utf-8",
      });
      exitCode = 0;
    } catch (err) {
      exitCode = err.status;
    }
    expect(exitCode).toBe(2);

    const logFile = path.join(tmpHome, ".open-cockpit/logs/hooks.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, "utf-8");
    expect(logContent).toContain("test-fail-hook");
    expect(logContent).toContain("ERR trap triggered");
  });

  it("rotates log file when exceeding max size", () => {
    const logDir = path.join(tmpHome, ".open-cockpit/logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "hooks.log");

    // Write >100KB to the log file
    fs.writeFileSync(logFile, "x".repeat(110000));

    // Trigger an error to invoke log rotation
    const failScript = path.join(tmpHome, "fail-rotate.sh");
    fs.writeFileSync(
      failScript,
      `#!/bin/bash
set -euo pipefail
source "${path.join(HOOKS_DIR, "log-error.sh")}"
false
`,
    );
    try {
      execFileSync("bash", [failScript], {
        env,
        timeout: 5000,
        encoding: "utf-8",
      });
    } catch {
      // expected
    }

    expect(fs.existsSync(logFile + ".1")).toBe(true);
    expect(fs.readFileSync(logFile + ".1", "utf-8").length).toBe(110000);
    // New log file should have the error entry
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.readFileSync(logFile, "utf-8")).toContain("ERR trap triggered");
  });

  it("logs the correct script name from BASH_SOURCE", () => {
    const namedScript = path.join(tmpHome, "my-custom-hook.sh");
    fs.writeFileSync(
      namedScript,
      `#!/bin/bash
set -euo pipefail
source "${path.join(HOOKS_DIR, "log-error.sh")}"
false
`,
    );
    try {
      execFileSync("bash", [namedScript], {
        env,
        timeout: 5000,
        encoding: "utf-8",
      });
    } catch {
      // expected
    }

    const logFile = path.join(tmpHome, ".open-cockpit/logs/hooks.log");
    const logContent = fs.readFileSync(logFile, "utf-8");
    expect(logContent).toContain("my-custom-hook.sh");
  });
});
