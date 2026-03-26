import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let platform;

beforeAll(() => {
  env = createTestEnv("platform-test");
  platform = env.requireFresh("platform.js");
});

afterAll(() => {
  env.cleanup();
});

describe("resolveClaudePath", () => {
  it("returns a string path or throws", () => {
    try {
      const result = platform.resolveClaudePath();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } catch (err) {
      expect(err.message).toMatch(/Claude binary not found/);
    }
  });
});

describe("getAllowedShells", () => {
  it("returns a Set of shell paths", () => {
    const shells = platform.getAllowedShells();

    expect(shells).toBeInstanceOf(Set);
    expect(shells.size).toBeGreaterThan(0);

    for (const shell of shells) {
      expect(typeof shell).toBe("string");
      expect(shell.length).toBeGreaterThan(0);
    }
  });

  it("includes platform-appropriate shells", () => {
    const shells = platform.getAllowedShells();

    if (platform.IS_MAC) {
      expect(shells.has("/bin/zsh")).toBe(true);
      expect(shells.has("/bin/bash")).toBe(true);
    } else if (platform.IS_LINUX) {
      expect(shells.has("/bin/bash")).toBe(true);
      expect(shells.has("/bin/sh")).toBe(true);
    } else if (platform.IS_WINDOWS) {
      expect(shells.size).toBeGreaterThan(0);
    }
  });
});

describe("getDefaultShell", () => {
  it("returns a non-empty string", () => {
    const shell = platform.getDefaultShell();
    expect(typeof shell).toBe("string");
    expect(shell.length).toBeGreaterThan(0);
  });

  it("returns a path that exists on this system", () => {
    if (platform.IS_WINDOWS) return;
    const shell = platform.getDefaultShell();
    expect(fs.existsSync(shell)).toBe(true);
  });
});

describe("isRootPath", () => {
  it('returns true for "/"', () => {
    expect(platform.isRootPath("/")).toBe(true);
  });

  it("returns false for non-root paths", () => {
    expect(platform.isRootPath("/Users")).toBe(false);
    expect(platform.isRootPath("/home/user")).toBe(false);
    expect(platform.isRootPath("/tmp")).toBe(false);
    expect(platform.isRootPath("/var/log")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(platform.isRootPath("")).toBe(false);
  });
});

describe("joinPathEnv", () => {
  it("joins directories with platform separator", () => {
    const result = platform.joinPathEnv(["/a", "/b"], "/existing");
    expect(result).toBe(`/a${path.delimiter}/b${path.delimiter}/existing`);
  });

  it("handles empty existing path", () => {
    const result = platform.joinPathEnv(["/a"], "");
    expect(result).toBe(`/a${path.delimiter}`);
  });

  it("handles null existing path", () => {
    const result = platform.joinPathEnv(["/a"], null);
    expect(result).toBe(`/a${path.delimiter}`);
  });
});

describe("getExtraPathDirs", () => {
  it("returns an array of directory paths", () => {
    const dirs = platform.getExtraPathDirs();
    expect(Array.isArray(dirs)).toBe(true);
    // May be empty when run from a terminal where PATH already includes
    // all login shell dirs (extra dirs = login PATH minus current PATH).
    for (const dir of dirs) {
      expect(typeof dir).toBe("string");
      expect(path.isAbsolute(dir)).toBe(true);
    }
  });

  it("returns dirs not already in process.env.PATH", () => {
    const dirs = platform.getExtraPathDirs();
    const currentDirs = new Set((process.env.PATH || "").split(path.delimiter));
    for (const dir of dirs) {
      expect(currentDirs.has(dir)).toBe(false);
    }
  });
});

describe("findFileRecursive", () => {
  it("finds a file in a nested directory", async () => {
    const nested = env.resolve("a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "target.txt"), "found");

    const result = await platform.findFileRecursive(env.dir, "target.txt");
    expect(result).toBe(path.join(nested, "target.txt"));
  });

  it("returns null when file does not exist", async () => {
    const result = await platform.findFileRecursive(env.dir, "nonexistent.txt");
    expect(result).toBe(null);
  });

  it("returns null when directory does not exist", async () => {
    const result = await platform.findFileRecursive(
      env.resolve("no-such-dir"),
      "file.txt",
    );
    expect(result).toBe(null);
  });
});

describe("chmodSync", () => {
  it("changes file permissions on non-Windows", () => {
    if (platform.IS_WINDOWS) return;

    const file = env.resolve("chmod-test.txt");
    fs.writeFileSync(file, "test");

    platform.chmodSync(file, 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);

    platform.chmodSync(file, 0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("readFileTail", () => {
  it("reads the last N lines of a file", async () => {
    const file = env.resolve("tail-test.txt");
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const result = await platform.readFileTail(file, 5);

    expect(result.trim().split("\n")).toHaveLength(5);
    expect(result).toContain("line 100");
    expect(result).toContain("line 96");
  });

  it("returns empty string for nonexistent file", async () => {
    const result = await platform.readFileTail(
      env.resolve("nonexistent.txt"),
      10,
    );
    expect(result).toBe("");
  });
});

describe("platform constants", () => {
  it("exports boolean platform flags", () => {
    expect(typeof platform.IS_WINDOWS).toBe("boolean");
    expect(typeof platform.IS_LINUX).toBe("boolean");
    expect(typeof platform.IS_MAC).toBe("boolean");

    const trueCount = [
      platform.IS_WINDOWS,
      platform.IS_LINUX,
      platform.IS_MAC,
    ].filter(Boolean).length;
    expect(trueCount).toBe(1);
  });
});
