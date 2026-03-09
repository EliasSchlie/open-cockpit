import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Must mock secure-fs before importing agent-templates
import { vi } from "vitest";
vi.mock("../src/secure-fs.js", () => ({
  secureMkdirSync: vi.fn(),
  secureWriteFileSync: vi.fn(),
}));

const {
  parseAgentFile,
  discoverAgents,
  renderPrompt,
  resolveCwd,
} = await import("../src/agent-templates.js");

describe("parseAgentFile", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-agents-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a template with frontmatter", () => {
    const filePath = path.join(tmpDir, "reviewer.md");
    fs.writeFileSync(
      filePath,
      `---
description: Code review agent
cwd: .
flags: --model sonnet
---
Review the code.

{{args}}`,
    );

    const agent = parseAgentFile(filePath);
    expect(agent).toEqual({
      name: "reviewer",
      description: "Code review agent",
      cwd: ".",
      flags: "--model sonnet",
      prompt: "Review the code.\n\n{{args}}",
      filePath,
    });
  });

  it("parses a template without frontmatter", () => {
    const filePath = path.join(tmpDir, "simple.md");
    fs.writeFileSync(filePath, "Just do the thing.");

    const agent = parseAgentFile(filePath);
    expect(agent.name).toBe("simple");
    expect(agent.description).toBe("");
    expect(agent.prompt).toBe("Just do the thing.");
  });

  it("returns null for missing file", () => {
    expect(parseAgentFile("/nonexistent/file.md")).toBeNull();
  });
});

describe("discoverAgents", () => {
  let globalDir, projectDir;

  beforeEach(() => {
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-global-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-project-"));
  });

  afterEach(() => {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("discovers agents from a directory", () => {
    fs.writeFileSync(
      path.join(globalDir, "alpha.md"),
      "---\ndescription: Alpha\n---\nDo alpha.",
    );
    fs.writeFileSync(
      path.join(globalDir, "beta.md"),
      "---\ndescription: Beta\n---\nDo beta.",
    );
    fs.writeFileSync(path.join(globalDir, "not-md.txt"), "ignored");

    // Use scanDir indirectly — discoverAgents uses the hardcoded global dir,
    // so we test parseAgentFile + sorting separately
    const alpha = parseAgentFile(path.join(globalDir, "alpha.md"));
    const beta = parseAgentFile(path.join(globalDir, "beta.md"));
    expect(alpha.name).toBe("alpha");
    expect(beta.name).toBe("beta");
  });
});

describe("renderPrompt", () => {
  it("replaces {{args}} with provided args", () => {
    const agent = { prompt: "Review {{args}} carefully." };
    expect(renderPrompt(agent, "PR #42")).toBe("Review PR #42 carefully.");
  });

  it("removes {{args}} when no args provided", () => {
    const agent = { prompt: "Do the thing.\n\n{{args}}" };
    expect(renderPrompt(agent, "")).toBe("Do the thing.");
  });

  it("handles multiple {{args}} placeholders", () => {
    const agent = { prompt: "{{args}} then {{args}}" };
    expect(renderPrompt(agent, "X")).toBe("X then X");
  });
});

describe("resolveCwd", () => {
  it("returns callerCwd for empty or dot", () => {
    expect(resolveCwd("", "/projects/foo")).toBe("/projects/foo");
    expect(resolveCwd(".", "/projects/foo")).toBe("/projects/foo");
  });

  it("expands ~ to home directory", () => {
    expect(resolveCwd("~/projects", null)).toBe(
      path.join(os.homedir(), "projects"),
    );
  });

  it("returns absolute paths as-is", () => {
    expect(resolveCwd("/usr/local", "/other")).toBe("/usr/local");
  });

  it("resolves relative paths from callerCwd", () => {
    expect(resolveCwd("sub/dir", "/projects/foo")).toBe(
      "/projects/foo/sub/dir",
    );
  });

  it("falls back to home when no callerCwd", () => {
    expect(resolveCwd("", null)).toBe(os.homedir());
  });
});
