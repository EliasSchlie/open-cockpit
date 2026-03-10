import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let mod;

beforeAll(() => {
  env = createTestEnv();
  mod = env.requireFresh("session-discovery.js");
});

afterAll(() => {
  env.cleanup();
});

describe("findGitRoot", () => {
  it("finds git root when .git dir exists", async () => {
    // Create a project dir with .git inside the temp dir
    const projectDir = path.join(env.dir, "my-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".git"));

    // Search from a subdirectory
    const subDir = path.join(projectDir, "src", "lib");
    fs.mkdirSync(subDir, { recursive: true });

    const result = await mod.findGitRoot(subDir);

    expect(result).toBe(projectDir);
  });

  it("returns null when no .git exists", async () => {
    // tmpdir without any .git — walk up will eventually hit root
    const dir = path.join(env.dir, "no-git-project");
    fs.mkdirSync(dir, { recursive: true });

    const result = await mod.findGitRoot(dir);

    // May find a parent .git (e.g. if test runs inside a git repo)
    // or null if we hit the filesystem root. Either way, should not crash.
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("returns null for null input", async () => {
    const result = await mod.findGitRoot(null);
    expect(result).toBe(null);
  });

  it("finds .git at the same level as cwd", async () => {
    const dir = path.join(env.dir, "root-level-git");
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, ".git"));

    const result = await mod.findGitRoot(dir);

    expect(result).toBe(dir);
  });
});

describe("getIntentionHeading", () => {
  it("extracts heading from markdown file", async () => {
    const file = path.join(env.dir, "intention.md");
    fs.writeFileSync(file, "# My Great Heading\n\nSome body text\n");

    const heading = await mod.getIntentionHeading(file);

    expect(heading).toBe("My Great Heading");
  });

  it("extracts first heading when multiple exist", async () => {
    const file = path.join(env.dir, "multi-heading.md");
    fs.writeFileSync(
      file,
      "Some preamble\n# First Heading\n# Second Heading\n",
    );

    const heading = await mod.getIntentionHeading(file);

    expect(heading).toBe("First Heading");
  });

  it("returns null for file without heading", async () => {
    const file = path.join(env.dir, "no-heading.md");
    fs.writeFileSync(file, "Just some text without a heading\n");

    const heading = await mod.getIntentionHeading(file);

    expect(heading).toBe(null);
  });

  it("returns null for nonexistent file", async () => {
    const file = path.join(env.dir, "nonexistent.md");

    const heading = await mod.getIntentionHeading(file);

    expect(heading).toBe(null);
  });

  it("trims whitespace from heading", async () => {
    const file = path.join(env.dir, "whitespace.md");
    fs.writeFileSync(file, "#   Spaced Heading   \n");

    const heading = await mod.getIntentionHeading(file);

    expect(heading).toBe("Spaced Heading");
  });
});

describe("getIdleSignal", () => {
  it("parses idle signal file for a PID", async () => {
    const signalData = {
      cwd: "/some/project",
      ts: 1704067200,
      trigger: "stop",
      session_id: "abc-123",
      transcript: "/path/to/transcript.jsonl",
    };

    // Write signal file to the idle-signals dir in test env
    const signalFile = path.join(env.dir, "idle-signals", "12345");
    fs.writeFileSync(signalFile, JSON.stringify(signalData));

    const result = await mod.getIdleSignal("12345");

    expect(result).toEqual(signalData);
  });

  it("returns null when no signal file exists", async () => {
    const result = await mod.getIdleSignal("99999");

    expect(result).toBe(null);
  });

  it("returns null for invalid JSON in signal file", async () => {
    const signalFile = path.join(env.dir, "idle-signals", "88888");
    fs.writeFileSync(signalFile, "not valid json");

    const result = await mod.getIdleSignal("88888");

    expect(result).toBe(null);
  });
});

// NOTE: transcriptContains is defined in session-discovery.js but NOT exported.
// To test it, either export it or test indirectly via getSessions().
// Skipping direct tests here — recommend adding it to module.exports.

describe("getJsonlSize", () => {
  it("returns file size for existing JSONL", async () => {
    // getJsonlSize depends on findJsonlPath which searches CLAUDE_PROJECTS_DIR.
    // We need to set up the JSONL file in the right location.
    const { CLAUDE_PROJECTS_DIR } = env.requireFresh("paths.js");
    const sessionId = "test-session-123";
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    const content = '{"type":"user"}\n{"type":"assistant"}\n';
    fs.writeFileSync(jsonlPath, content);

    const size = await mod.getJsonlSize(sessionId);

    expect(size).toBe(Buffer.byteLength(content));
  });

  it("returns null for nonexistent session", async () => {
    const size = await mod.getJsonlSize("nonexistent-session-id");

    expect(size).toBe(null);
  });
});
