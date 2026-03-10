import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const TMP_DIR = path.join(
  os.tmpdir(),
  "open-cockpit-platform-test-" + process.pid,
);

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  for (const key of Object.keys(require.cache)) {
    if (key.includes("/src/")) delete require.cache[key];
  }
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function loadPlatform() {
  return require("../src/platform.js");
}

describe("resolveClaudePath", () => {
  it("returns a string path or throws", () => {
    const { resolveClaudePath } = loadPlatform();
    try {
      const result = resolveClaudePath();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } catch (err) {
      // If claude is not installed, it should throw with a clear message
      expect(err.message).toMatch(/Claude binary not found/);
    }
  });
});

describe("getAllowedShells", () => {
  it("returns a Set of shell paths", () => {
    const { getAllowedShells } = loadPlatform();
    const shells = getAllowedShells();

    expect(shells).toBeInstanceOf(Set);
    expect(shells.size).toBeGreaterThan(0);

    for (const shell of shells) {
      expect(typeof shell).toBe("string");
      expect(shell.length).toBeGreaterThan(0);
    }
  });

  it("includes platform-appropriate shells", () => {
    const { getAllowedShells, IS_MAC, IS_LINUX, IS_WINDOWS } = loadPlatform();
    const shells = getAllowedShells();

    if (IS_MAC) {
      expect(shells.has("/bin/zsh")).toBe(true);
      expect(shells.has("/bin/bash")).toBe(true);
    } else if (IS_LINUX) {
      expect(shells.has("/bin/bash")).toBe(true);
      expect(shells.has("/bin/sh")).toBe(true);
    } else if (IS_WINDOWS) {
      // Should have at least one Windows shell
      expect(shells.size).toBeGreaterThan(0);
    }
  });
});

describe("getDefaultShell", () => {
  it("returns a non-empty string", () => {
    const { getDefaultShell } = loadPlatform();
    const shell = getDefaultShell();

    expect(typeof shell).toBe("string");
    expect(shell.length).toBeGreaterThan(0);
  });

  it("returns a path that exists on this system", () => {
    const { getDefaultShell, IS_WINDOWS } = loadPlatform();
    if (IS_WINDOWS) return; // Windows paths may not be verifiable this way

    const shell = getDefaultShell();
    expect(fs.existsSync(shell)).toBe(true);
  });
});

describe("isRootPath", () => {
  it('returns true for "/"', () => {
    const { isRootPath } = loadPlatform();
    expect(isRootPath("/")).toBe(true);
  });

  it("returns false for non-root paths", () => {
    const { isRootPath } = loadPlatform();
    expect(isRootPath("/Users")).toBe(false);
    expect(isRootPath("/home/user")).toBe(false);
    expect(isRootPath("/tmp")).toBe(false);
    expect(isRootPath("/var/log")).toBe(false);
  });

  it("returns false for empty string", () => {
    const { isRootPath } = loadPlatform();
    expect(isRootPath("")).toBe(false);
  });
});

describe("joinPathEnv", () => {
  it("joins directories with platform separator", () => {
    const { joinPathEnv } = loadPlatform();
    const result = joinPathEnv(["/a", "/b"], "/existing");

    expect(result).toBe(`/a${path.delimiter}/b${path.delimiter}/existing`);
  });

  it("handles empty existing path", () => {
    const { joinPathEnv } = loadPlatform();
    const result = joinPathEnv(["/a"], "");

    expect(result).toBe(`/a${path.delimiter}`);
  });

  it("handles null existing path", () => {
    const { joinPathEnv } = loadPlatform();
    const result = joinPathEnv(["/a"], null);

    expect(result).toBe(`/a${path.delimiter}`);
  });
});

describe("getExtraPathDirs", () => {
  it("returns an array of directory paths", () => {
    const { getExtraPathDirs } = loadPlatform();
    const dirs = getExtraPathDirs();

    expect(Array.isArray(dirs)).toBe(true);
    expect(dirs.length).toBeGreaterThan(0);

    for (const dir of dirs) {
      expect(typeof dir).toBe("string");
      expect(path.isAbsolute(dir)).toBe(true);
    }
  });

  it("includes .claude/local/bin in home dir", () => {
    const { getExtraPathDirs } = loadPlatform();
    const dirs = getExtraPathDirs();
    const home = os.homedir();

    expect(dirs).toContain(path.join(home, ".claude", "local", "bin"));
  });
});

describe("findFileRecursive", () => {
  it("finds a file in a nested directory", async () => {
    const { findFileRecursive } = loadPlatform();
    const nested = path.join(TMP_DIR, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "target.txt"), "found");

    const result = await findFileRecursive(TMP_DIR, "target.txt");

    expect(result).toBe(path.join(nested, "target.txt"));
  });

  it("returns null when file does not exist", async () => {
    const { findFileRecursive } = loadPlatform();

    const result = await findFileRecursive(TMP_DIR, "nonexistent.txt");

    expect(result).toBe(null);
  });

  it("returns null when directory does not exist", async () => {
    const { findFileRecursive } = loadPlatform();

    const result = await findFileRecursive(
      path.join(TMP_DIR, "no-such-dir"),
      "file.txt",
    );

    expect(result).toBe(null);
  });
});

describe("chmodSync", () => {
  it("changes file permissions on non-Windows", () => {
    const { chmodSync, IS_WINDOWS } = loadPlatform();
    if (IS_WINDOWS) return;

    const file = path.join(TMP_DIR, "chmod-test.txt");
    fs.writeFileSync(file, "test");

    chmodSync(file, 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);

    chmodSync(file, 0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("readFileTail", () => {
  it("reads the last N lines of a file", async () => {
    const { readFileTail } = loadPlatform();
    const file = path.join(TMP_DIR, "tail-test.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const result = await readFileTail(file, 5);

    expect(result.trim().split("\n")).toHaveLength(5);
    expect(result).toContain("line 100");
    expect(result).toContain("line 96");
  });

  it("returns empty string for nonexistent file", async () => {
    const { readFileTail } = loadPlatform();

    const result = await readFileTail(
      path.join(TMP_DIR, "nonexistent.txt"),
      10,
    );

    expect(result).toBe("");
  });
});

describe("platform constants", () => {
  it("exports boolean platform flags", () => {
    const { IS_WINDOWS, IS_LINUX, IS_MAC } = loadPlatform();

    expect(typeof IS_WINDOWS).toBe("boolean");
    expect(typeof IS_LINUX).toBe("boolean");
    expect(typeof IS_MAC).toBe("boolean");

    // Exactly one should be true (on standard platforms)
    const trueCount = [IS_WINDOWS, IS_LINUX, IS_MAC].filter(Boolean).length;
    expect(trueCount).toBe(1);
  });
});
