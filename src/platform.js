/**
 * Platform abstraction layer — centralizes all OS-specific logic.
 *
 * macOS: ps eww, lsof, osascript, open -a
 * Linux: /proc filesystem
 * Windows: wmic, tasklist (best-effort, limited)
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const IS_MAC = process.platform === "darwin";

// --- Shell detection ---

const DEFAULT_SHELLS_MAC = ["/bin/zsh", "/bin/bash", "/bin/sh"];
const DEFAULT_SHELLS_LINUX = ["/bin/bash", "/bin/sh", "/bin/zsh"];
const DEFAULT_SHELLS_WINDOWS = [
  process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
];

function getAllowedShells() {
  if (IS_WINDOWS) return new Set(DEFAULT_SHELLS_WINDOWS);
  if (IS_LINUX) return new Set(DEFAULT_SHELLS_LINUX);
  return new Set(DEFAULT_SHELLS_MAC);
}

function getDefaultShell() {
  if (IS_WINDOWS) {
    return process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

// --- PATH separator ---

function joinPathEnv(dirs, existingPath) {
  return [...dirs, existingPath || ""].join(path.delimiter);
}

// --- Extra PATH directories ---

let _cachedExtraDirs = null;

function getExtraPathDirs() {
  if (_cachedExtraDirs) return _cachedExtraDirs;

  if (IS_WINDOWS) {
    _cachedExtraDirs = [];
    return _cachedExtraDirs;
  }

  // Try resolving PATH from a login shell — picks up Homebrew, nvm, etc.
  // that aren't in process.env.PATH when launched from Dock/Spotlight.
  try {
    const shell = getDefaultShell();
    const loginPath = execFileSync(shell, ["-lc", "echo $PATH"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    if (loginPath) {
      const currentDirs = new Set(
        (process.env.PATH || "").split(path.delimiter),
      );
      _cachedExtraDirs = loginPath
        .split(path.delimiter)
        .filter((d) => d && !currentDirs.has(d));
      console.log(
        `[platform] Login shell PATH resolved ${_cachedExtraDirs.length} extra dirs`,
      );
      return _cachedExtraDirs;
    }
  } catch (err) {
    console.error(
      "[platform] Login shell PATH failed, using fallback:",
      err.message,
    );
  }

  // Fallback: hardcoded essentials
  const home = os.homedir();
  _cachedExtraDirs = [
    path.join(home, ".claude", "local", "bin"),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
  ];
  return _cachedExtraDirs;
}

// --- Claude binary discovery ---

function resolveClaudePath() {
  const whichCmd = IS_WINDOWS ? "where" : "which";
  try {
    const { execFileSync } = require("child_process");
    return execFileSync(whichCmd, ["claude"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    /* not in PATH — fall through to candidates */
  }
  const home = os.homedir();
  const candidates = [
    path.join(
      home,
      ".claude",
      "local",
      "bin",
      IS_WINDOWS ? "claude.exe" : "claude",
    ),
    ...(IS_WINDOWS ? [] : ["/usr/local/bin/claude"]),
    path.join(home, ".local", "bin", IS_WINDOWS ? "claude.exe" : "claude"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Claude binary not found");
}

// --- Process CWD detection ---

async function batchGetCwds(pids) {
  const cwdMap = new Map();
  if (pids.length === 0) return cwdMap;

  if (IS_LINUX) {
    // Use /proc/<pid>/cwd symlinks
    for (const pid of pids) {
      try {
        const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`);
        cwdMap.set(String(pid), cwd);
      } catch {
        /* ENOENT/EACCES — process may have exited or be owned by another user */
      }
    }
    return cwdMap;
  }

  if (IS_WINDOWS) {
    // Windows: no reliable way to get CWD of another process without debug APIs.
    // Return empty — callers fall back to JSONL-based CWD detection.
    return cwdMap;
  }

  // macOS: lsof
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-p", pids.join(","), "-d", "cwd", "-F", "pn"],
      { encoding: "utf-8", timeout: 5000 },
    );
    let currentPid = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = line.slice(1);
      } else if (line.startsWith("n") && currentPid) {
        cwdMap.set(currentPid, line.slice(1));
      }
    }
  } catch (err) {
    console.error(
      "[platform] lsof failed to resolve session cwds:",
      err.message,
    );
  }
  return cwdMap;
}

// Synchronous single-PID CWD lookup (used by saveExternalClearOffload)
function getCwdSync(pid) {
  if (IS_LINUX) {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (IS_WINDOWS) {
    return null;
  }

  // macOS: lsof
  try {
    const { execFileSync } = require("child_process");
    const output = execFileSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] },
    );
    const m = output.match(/^n(.+)$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// --- Process environment detection (for origin tagging) ---

// Returns { format: "per-pid", byPid: Map<string, string> } on Linux,
//         { format: "raw-ps", raw: string } on macOS,
//         { format: "unavailable" } on Windows.
async function batchGetProcessEnvs(pids) {
  if (pids.length === 0) return { format: "unavailable" };

  if (IS_LINUX) {
    const byPid = new Map();
    // Read /proc/<pid>/environ in parallel
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const raw = await fs.promises.readFile(
            `/proc/${pid}/environ`,
            "utf-8",
          );
          // Replace null bytes with spaces so regex matching works
          byPid.set(String(pid), raw.replace(/\0/g, " "));
        } catch {
          /* ENOENT/EACCES — process may have exited */
        }
      }),
    );
    return { format: "per-pid", byPid };
  }

  if (IS_WINDOWS) {
    // Windows: reading another process's environment requires debug APIs.
    return { format: "unavailable" };
  }

  // macOS: ps eww — single call returns all PIDs
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["eww", "-p", pids.join(",")],
      { encoding: "utf-8", timeout: 3000 },
    );
    return { format: "raw-ps", raw: stdout };
  } catch {
    /* ps failed — callers default to "ext" */
    return { format: "unavailable" };
  }
}

// --- Process tree walking (for terminal app detection) ---

function getParentPidSync(pid) {
  if (IS_LINUX) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const match = stat.match(/^\d+\s+\(.+?\)\s+\S+\s+(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
  // macOS and Windows
  const { execFileSync } = require("child_process");
  if (IS_WINDOWS) {
    try {
      const stdout = execFileSync(
        "wmic",
        [
          "process",
          "where",
          `ProcessId=${pid}`,
          "get",
          "ParentProcessId",
          "/value",
        ],
        { encoding: "utf-8", timeout: 2000 },
      );
      const match = stdout.match(/ParentProcessId=(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
  try {
    return (
      execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 2000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

async function getParentPid(pid) {
  if (IS_LINUX) {
    try {
      const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf-8");
      // Format: pid (comm) state ppid ...
      const match = stat.match(/^\d+\s+\(.+?\)\s+\S+\s+(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  if (IS_WINDOWS) {
    try {
      const { stdout } = await execFileAsync(
        "wmic",
        [
          "process",
          "where",
          `ProcessId=${pid}`,
          "get",
          "ParentProcessId",
          "/value",
        ],
        { encoding: "utf-8", timeout: 3000 },
      );
      const match = stdout.match(/ParentProcessId=(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // macOS
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "ppid="],
      { timeout: 3000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getProcessName(pid) {
  if (IS_LINUX) {
    try {
      const comm = await fs.promises.readFile(`/proc/${pid}/comm`, "utf-8");
      return comm.trim();
    } catch {
      return null;
    }
  }

  if (IS_WINDOWS) {
    try {
      const { stdout } = await execFileAsync(
        "wmic",
        ["process", "where", `ProcessId=${pid}`, "get", "Name", "/value"],
        { encoding: "utf-8", timeout: 3000 },
      );
      const match = stdout.match(/Name=(.+)/);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  // macOS
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "comm="],
      { timeout: 3000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// --- TTY detection (for iTerm integration — macOS only) ---

async function getProcessTty(pid) {
  if (!IS_MAC) return null;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "tty="],
      { timeout: 3000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// --- App activation (macOS-only, no-op elsewhere) ---

async function activateApp(appName) {
  if (!IS_MAC) return false;
  try {
    await execFileAsync("osascript", [
      "-e",
      `tell application "${appName}" to activate`,
    ]);
    return true;
  } catch {
    return false;
  }
}

// --- Open file/folder in editor (cross-platform) ---

async function openInApp(appName, target) {
  if (IS_MAC) {
    await execFileAsync("open", ["-a", appName, target]);
    return;
  }
  if (IS_LINUX) {
    // Try launching the app directly (e.g., "cursor", "code")
    const cmd = appName.toLowerCase().replace(/\s+/g, "");
    const { spawn: spawnChild } = require("child_process");
    spawnChild(cmd, [target], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  // Windows
  const { spawn: spawnChild } = require("child_process");
  spawnChild("cmd", ["/c", "start", "", appName, target], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

// Open a file or directory in Cursor using the CLI (reliable, unlike `open -a`
// which just activates the app without switching to the requested directory).
async function openInCursor(target) {
  try {
    const env = {
      ...process.env,
      PATH: joinPathEnv(getExtraPathDirs(), process.env.PATH),
    };
    await execFileAsync("cursor", [target], { timeout: 10000, env });
    // CLI opens the folder but doesn't activate — bring Cursor to front
    await activateApp("Cursor");
  } catch {
    await openInApp("Cursor", target);
  }

  // Switch to the Source Control (Git) tab via Ctrl+Shift+G keystroke
  if (IS_MAC) {
    try {
      await execFileAsync(
        "osascript",
        [
          "-e",
          'tell application "System Events" to keystroke "g" using {control down, shift down}',
        ],
        { timeout: 5000 },
      );
    } catch {
      /* best-effort */
    }
  }
}

// --- iTerm2 AppleScript interaction (macOS-only) ---

async function withITermSessionByTty(tty, action, resultValue) {
  if (!IS_MAC) return null;
  if (!tty || tty === "??" || !/^ttys?\d+$/.test(tty)) return null;
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
  if not (exists process "iTerm2") then return "not_running"
end tell
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s ends with "${tty}" then
          ${action}
          return "${resultValue}"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`,
      ],
      { timeout: 3000 },
    );
    if (stdout.trim() === resultValue) return { app: "iTerm" };
  } catch (err) {
    console.error(
      `[platform] iTerm ${resultValue} via osascript failed:`,
      err.message,
    );
  }
  return null;
}

// --- File read with tail (cross-platform) ---

async function readFileTail(filePath, lineCount) {
  if (IS_WINDOWS) {
    // Use PowerShell's Get-Content -Tail for efficiency on large files
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-Content '${filePath}' -Tail ${lineCount}`,
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      return stdout;
    } catch {
      return "";
    }
  }
  // Unix: use tail for efficiency on large files
  try {
    const { stdout } = await execFileAsync(
      "tail",
      [`-${lineCount}`, filePath],
      { encoding: "utf-8", timeout: 3000 },
    );
    return stdout;
  } catch {
    return "";
  }
}

// --- File search (cross-platform replacement for find) ---

async function findFileRecursive(dir, filename) {
  // Use Node.js recursive readdir instead of shell `find`
  try {
    const entries = await fs.promises.readdir(dir, {
      withFileTypes: true,
      recursive: true,
    });
    for (const entry of entries) {
      if (entry.name === filename) {
        // entry.parentPath available in Node 20+
        const parentPath = entry.parentPath || entry.path;
        return path.join(parentPath, entry.name);
      }
    }
  } catch {
    /* ENOENT or permission error — directory may not exist */
  }
  return null;
}

// --- File permissions (no-op on Windows) ---

function chmodSync(filePath, mode) {
  if (IS_WINDOWS) return; // Windows uses ACLs, chmod is a no-op
  fs.chmodSync(filePath, mode);
}

// --- Root path check ---

function isRootPath(p) {
  if (IS_WINDOWS) {
    // C:\, D:\, etc.
    return /^[A-Za-z]:\\?$/.test(p);
  }
  return p === "/";
}

module.exports = {
  IS_WINDOWS,
  IS_LINUX,
  IS_MAC,
  getAllowedShells,
  getDefaultShell,
  joinPathEnv,
  getExtraPathDirs,
  resolveClaudePath,
  batchGetCwds,
  getCwdSync,
  batchGetProcessEnvs,
  getParentPid,
  getParentPidSync,
  getProcessName,
  getProcessTty,
  activateApp,
  openInApp,
  openInCursor,
  withITermSessionByTty,
  readFileTail,
  findFileRecursive,
  chmodSync,
  isRootPath,
};
