import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let secureMkdirSync, secureWriteFileSync, readJsonSync;

beforeAll(() => {
  env = createTestEnv("secure-fs-test");
  ({ secureMkdirSync, secureWriteFileSync, readJsonSync } =
    env.requireFresh("secure-fs.js"));
});

afterAll(() => {
  env.cleanup();
});

describe("secureMkdirSync", () => {
  it("creates directory with mode 0o700", () => {
    const dir = env.resolve("secure-dir");
    secureMkdirSync(dir);

    const stat = fs.statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("passes through options like recursive", () => {
    const dir = env.resolve("a", "b", "c");
    secureMkdirSync(dir, { recursive: true });

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("secureWriteFileSync", () => {
  it("writes file with mode 0o600", () => {
    const file = env.resolve("secure-file.txt");
    secureWriteFileSync(file, "secret data");

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).toBe("secret data");
  });

  it("passes through encoding option", () => {
    const file = env.resolve("encoded.txt");
    secureWriteFileSync(file, "hello", { encoding: "utf-8" });

    expect(fs.readFileSync(file, "utf-8")).toBe("hello");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("readJsonSync", () => {
  it("returns parsed JSON for valid file", () => {
    const file = env.resolve("valid.json");
    fs.writeFileSync(file, JSON.stringify({ key: "value", num: 42 }));

    expect(readJsonSync(file)).toEqual({ key: "value", num: 42 });
  });

  it("returns fallback on ENOENT", () => {
    const file = env.resolve("nonexistent.json");

    expect(readJsonSync(file)).toBe(null);
    expect(readJsonSync(file, {})).toEqual({});
    expect(readJsonSync(file, [])).toEqual([]);
  });

  it("returns fallback on invalid JSON", () => {
    const file = env.resolve("bad.json");
    fs.writeFileSync(file, "not { valid json");

    expect(readJsonSync(file)).toBe(null);
    expect(readJsonSync(file, { default: true })).toEqual({ default: true });
  });

  it("returns null as default fallback", () => {
    const file = env.resolve("missing.json");
    expect(readJsonSync(file)).toBe(null);
  });

  it("handles nested JSON structures", () => {
    const file = env.resolve("nested.json");
    const data = { a: { b: [1, 2, { c: true }] } };
    fs.writeFileSync(file, JSON.stringify(data));

    expect(readJsonSync(file)).toEqual(data);
  });
});
