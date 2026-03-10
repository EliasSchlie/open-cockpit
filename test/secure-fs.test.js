import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const TMP_DIR = path.join(
  os.tmpdir(),
  "open-cockpit-secure-fs-test-" + process.pid,
);

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // Clear cached modules so secure-fs picks up fresh state
  for (const key of Object.keys(require.cache)) {
    if (key.includes("/src/")) delete require.cache[key];
  }
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function loadSecureFs() {
  return require("../src/secure-fs.js");
}

describe("secureMkdirSync", () => {
  it("creates directory with mode 0o700", () => {
    const { secureMkdirSync } = loadSecureFs();
    const dir = path.join(TMP_DIR, "secure-dir");

    secureMkdirSync(dir);

    const stat = fs.statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("passes through options like recursive", () => {
    const { secureMkdirSync } = loadSecureFs();
    const dir = path.join(TMP_DIR, "a", "b", "c");

    secureMkdirSync(dir, { recursive: true });

    expect(fs.existsSync(dir)).toBe(true);
    const stat = fs.statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("secureWriteFileSync", () => {
  it("writes file with mode 0o600", () => {
    const { secureWriteFileSync } = loadSecureFs();
    const file = path.join(TMP_DIR, "secure-file.txt");

    secureWriteFileSync(file, "secret data");

    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).toBe("secret data");
  });

  it("passes through encoding option", () => {
    const { secureWriteFileSync } = loadSecureFs();
    const file = path.join(TMP_DIR, "encoded.txt");

    secureWriteFileSync(file, "hello", { encoding: "utf-8" });

    expect(fs.readFileSync(file, "utf-8")).toBe("hello");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("readJsonSync", () => {
  it("returns parsed JSON for valid file", () => {
    const { readJsonSync } = loadSecureFs();
    const file = path.join(TMP_DIR, "valid.json");
    fs.writeFileSync(file, JSON.stringify({ key: "value", num: 42 }));

    const result = readJsonSync(file);

    expect(result).toEqual({ key: "value", num: 42 });
  });

  it("returns fallback on ENOENT", () => {
    const { readJsonSync } = loadSecureFs();
    const file = path.join(TMP_DIR, "nonexistent.json");

    expect(readJsonSync(file)).toBe(null);
    expect(readJsonSync(file, {})).toEqual({});
    expect(readJsonSync(file, [])).toEqual([]);
  });

  it("returns fallback on invalid JSON", () => {
    const { readJsonSync } = loadSecureFs();
    const file = path.join(TMP_DIR, "bad.json");
    fs.writeFileSync(file, "not { valid json");

    expect(readJsonSync(file)).toBe(null);
    expect(readJsonSync(file, { default: true })).toEqual({ default: true });
  });

  it("returns null as default fallback", () => {
    const { readJsonSync } = loadSecureFs();
    const file = path.join(TMP_DIR, "missing.json");

    expect(readJsonSync(file)).toBe(null);
  });

  it("handles nested JSON structures", () => {
    const { readJsonSync } = loadSecureFs();
    const file = path.join(TMP_DIR, "nested.json");
    const data = { a: { b: [1, 2, { c: true }] } };
    fs.writeFileSync(file, JSON.stringify(data));

    expect(readJsonSync(file)).toEqual(data);
  });
});
