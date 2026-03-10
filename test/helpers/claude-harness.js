/**
 * Test harness for spawning real Claude Code sessions and simulating
 * plugin hook side effects (PID files, idle signals, offload metadata).
 *
 * Used by E2E tests that exercise session-discovery, session-stats,
 * and API handlers against live Claude processes.
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

let cachedClaudePath = null;

/**
 * Spawn a Claude Code session and register it in the test env.
 * Returns { sessionId, pid, process, waitForExit }.
 */
export async function spawnTestSession(env, { prompt, sessionId, cwd } = {}) {
  const id = sessionId || crypto.randomUUID();
  if (!cachedClaudePath) {
    cachedClaudePath = (await execFileAsync("which", ["claude"])).stdout.trim();
  }
  const claudePath = cachedClaudePath;
  const workDir = cwd || env.dir;

  const args = ["--session-id", id];
  if (prompt) {
    args.push("-p", prompt, "--output-format", "text");
  }

  // Strip ALL Claude nesting-detection env vars so spawned sessions start cleanly
  const spawnEnv = { ...process.env };
  for (const k of Object.keys(spawnEnv)) {
    if (k.startsWith("CLAUDE")) delete spawnEnv[k];
  }

  const proc = spawn(claudePath, args, {
    cwd: workDir,
    // stdin must be 'ignore' — Claude Code hangs if given a pipe with no TTY
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv,
  });

  // Register PID -> session ID in test dir (simulating SessionStart hook)
  fs.writeFileSync(path.join(env.dir, "session-pids", String(proc.pid)), id);

  const waitForExit = new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d;
    });
    proc.stderr?.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  return { sessionId: id, pid: proc.pid, process: proc, waitForExit };
}

/**
 * Write an idle signal for a session in the test dir.
 */
export function writeIdleSignal(env, pid, sessionId, extra = {}) {
  const signal = {
    ts: Math.floor(Date.now() / 1000),
    cwd: env.dir,
    trigger: "tool-use",
    session_id: sessionId,
    ...extra,
  };
  fs.writeFileSync(
    path.join(env.dir, "idle-signals", String(pid)),
    JSON.stringify(signal),
  );
}

/**
 * Remove idle signal (simulating processing start).
 */
export function clearIdleSignal(env, pid) {
  try {
    fs.unlinkSync(path.join(env.dir, "idle-signals", String(pid)));
  } catch {
    /* ENOENT ok */
  }
}

/**
 * Write offload metadata for a session.
 */
export function writeOffloadMeta(env, sessionId, meta) {
  const dir = path.join(env.dir, "offloaded", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        sessionId,
        claudeSessionId: sessionId,
        cwd: env.dir,
        ...meta,
      },
      null,
      2,
    ),
  );
  return dir;
}
