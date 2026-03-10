import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), `preferences-test-${process.pid}`);
const prefsFile = path.join(tmpDir, "preferences.json");

// Set env before requiring the CJS module so paths.js picks it up, then restore
const origOcDir = process.env.OPEN_COCKPIT_DIR;
process.env.OPEN_COCKPIT_DIR = tmpDir;
const { getPreference, setPreference } = await import("../src/preferences.js");
if (origOcDir === undefined) {
  delete process.env.OPEN_COCKPIT_DIR;
} else {
  process.env.OPEN_COCKPIT_DIR = origOcDir;
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.unlinkSync(prefsFile);
  } catch {}
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("preferences", () => {
  it("returns undefined for missing key when no file exists", () => {
    expect(getPreference("bellMuted")).toBeUndefined();
  });

  it("returns fallback for missing key", () => {
    expect(getPreference("bellMuted", false)).toBe(false);
  });

  it("persists and retrieves a value", () => {
    setPreference("bellMuted", true);
    expect(getPreference("bellMuted")).toBe(true);
  });

  it("updates an existing value", () => {
    setPreference("bellMuted", true);
    setPreference("bellMuted", false);
    expect(getPreference("bellMuted")).toBe(false);
  });

  it("preserves other keys when updating", () => {
    setPreference("bellMuted", true);
    setPreference("otherSetting", "hello");
    expect(getPreference("bellMuted")).toBe(true);
    expect(getPreference("otherSetting")).toBe("hello");
  });

  it("writes valid JSON to disk", () => {
    setPreference("bellMuted", true);
    const raw = JSON.parse(fs.readFileSync(prefsFile, "utf-8"));
    expect(raw.bellMuted).toBe(true);
  });
});
