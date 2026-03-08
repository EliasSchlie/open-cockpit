import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// parseFlags is a pure function — safe to import directly from pool-manager
// even though pool-manager has heavy side effects (the module loads but the
// side-effecting functions aren't called).
let parseFlags;

// For settings tests, we need to mock POOL_SETTINGS_FILE
let getPoolFlags, setPoolFlags;
const tmpDir = path.join(os.tmpdir(), `pool-flags-test-${process.pid}`);
const settingsFile = path.join(tmpDir, "pool-settings.json");

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  // Clean up any leftover settings file
  try {
    fs.unlinkSync(settingsFile);
  } catch {}
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseFlags", () => {
  // Dynamic import to avoid top-level side effects failing in CI
  beforeEach(async () => {
    const mod = await import("../src/pool-manager.js");
    parseFlags = mod.parseFlags;
  });

  it("parses a single flag", () => {
    expect(parseFlags("--dangerously-skip-permissions")).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("parses multiple flags", () => {
    expect(parseFlags("--dangerously-skip-permissions --model sonnet")).toEqual(
      ["--dangerously-skip-permissions", "--model", "sonnet"],
    );
  });

  it("handles double-quoted strings", () => {
    expect(parseFlags('--model "claude sonnet"')).toEqual([
      "--model",
      "claude sonnet",
    ]);
  });

  it("handles single-quoted strings", () => {
    expect(parseFlags("--model 'claude sonnet'")).toEqual([
      "--model",
      "claude sonnet",
    ]);
  });

  it("handles backslash escapes", () => {
    expect(parseFlags("--model claude\\ sonnet")).toEqual([
      "--model",
      "claude sonnet",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseFlags("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseFlags("   ")).toEqual([]);
  });

  it("returns empty array for null/undefined", () => {
    expect(parseFlags(null)).toEqual([]);
    expect(parseFlags(undefined)).toEqual([]);
  });

  it("handles multiple spaces between args", () => {
    expect(parseFlags("--a    --b")).toEqual(["--a", "--b"]);
  });

  it("handles tabs as delimiters", () => {
    expect(parseFlags("--a\t--b")).toEqual(["--a", "--b"]);
  });

  it("handles mixed quotes", () => {
    expect(parseFlags(`--a "hello 'world'"`)).toEqual(["--a", "hello 'world'"]);
  });
});
