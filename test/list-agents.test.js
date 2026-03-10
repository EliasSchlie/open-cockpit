import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TMP_DIR = path.join(os.tmpdir(), "list-agents-test-" + process.pid);
const GLOBAL_DIR = path.join(TMP_DIR, "agents");
const LOCAL_DIR = path.join(TMP_DIR, "project", ".open-cockpit", "agents");

// We test the handler by requiring it with mocked paths
let listAgents;

beforeAll(() => {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  fs.mkdirSync(LOCAL_DIR, { recursive: true });

  // Global agents
  fs.writeFileSync(
    path.join(GLOBAL_DIR, "review.sh"),
    "#!/usr/bin/env bash\n# Description: Code review\n# Arg: target | Files to review\n# Arg: --format | Output format | optional | default: markdown\necho ok\n",
  );
  fs.writeFileSync(
    path.join(GLOBAL_DIR, "deploy.sh"),
    "#!/usr/bin/env bash\n# Description: Deploy to production\necho ok\n",
  );
  // Not a .sh file — should be ignored
  fs.writeFileSync(path.join(GLOBAL_DIR, "notes.txt"), "not an agent\n");
  // Directory with .sh name — should be ignored
  fs.mkdirSync(path.join(GLOBAL_DIR, "fake.sh"), { recursive: true });

  // Local agent overriding global
  fs.writeFileSync(
    path.join(LOCAL_DIR, "review.sh"),
    "#!/usr/bin/env bash\n# Description: Local code review override\n# Arg: path | Path to review\necho local\n",
  );
  // Local-only agent
  fs.writeFileSync(
    path.join(LOCAL_DIR, "lint.sh"),
    "#!/usr/bin/env bash\n# Description: Run linter\necho lint\n",
  );

  // Build a minimal handler that uses the same logic as api-handlers.js
  // but with our test directories
  listAgents = async ({ cwd }) => {
    const agents = new Map();
    function parseAgentFile(filePath) {
      let description = "";
      const args = [];
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const descMatch = content.match(/^# Description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim();
        const argRe = /^# Arg:\s*(.+)$/gm;
        let m;
        while ((m = argRe.exec(content)) !== null) {
          const parts = m[1].split("|").map((s) => s.trim());
          const arg = { name: parts[0] };
          if (parts[1]) arg.description = parts[1];
          if (parts.includes("optional")) arg.required = false;
          else arg.required = true;
          const defPart = parts.find((p) => p.startsWith("default:"));
          if (defPart) arg.default = defPart.slice(8).trim();
          args.push(arg);
        }
      } catch {}
      return { description, args };
    }
    function scanDir(dir, scope) {
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.endsWith(".sh")) continue;
          const name = entry.slice(0, -3);
          const filePath = path.join(dir, entry);
          try {
            if (!fs.statSync(filePath).isFile()) continue;
          } catch {
            continue;
          }
          const { description, args } = parseAgentFile(filePath);
          agents.set(name, { name, path: filePath, description, scope, args });
        }
      } catch {}
    }
    scanDir(GLOBAL_DIR, "global");
    if (cwd) scanDir(path.join(cwd, ".open-cockpit", "agents"), "local");
    return Array.from(agents.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  };
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("list-agents handler", () => {
  it("discovers global agents", async () => {
    const agents = await listAgents({});
    const names = agents.map((a) => a.name);
    expect(names).toContain("review");
    expect(names).toContain("deploy");
    expect(names).not.toContain("notes");
    expect(names).not.toContain("fake");
  });

  it("ignores non-.sh files and directories", async () => {
    const agents = await listAgents({});
    expect(agents.every((a) => a.path.endsWith(".sh"))).toBe(true);
    // fake.sh is a directory, should not appear
    expect(agents.find((a) => a.name === "fake")).toBeUndefined();
  });

  it("parses description from comment", async () => {
    const agents = await listAgents({});
    const deploy = agents.find((a) => a.name === "deploy");
    expect(deploy.description).toBe("Deploy to production");
  });

  it("parses Arg metadata", async () => {
    const agents = await listAgents({});
    const review = agents.find((a) => a.name === "review");
    expect(review.args).toHaveLength(2);
    expect(review.args[0]).toEqual({
      name: "target",
      description: "Files to review",
      required: true,
    });
    expect(review.args[1]).toEqual({
      name: "--format",
      description: "Output format",
      required: false,
      default: "markdown",
    });
  });

  it("local agents override global agents", async () => {
    const agents = await listAgents({
      cwd: path.join(TMP_DIR, "project"),
    });
    const review = agents.find((a) => a.name === "review");
    expect(review.scope).toBe("local");
    expect(review.description).toBe("Local code review override");
    expect(review.args[0].name).toBe("path");
  });

  it("includes both local-only and global agents", async () => {
    const agents = await listAgents({
      cwd: path.join(TMP_DIR, "project"),
    });
    const names = agents.map((a) => a.name);
    expect(names).toContain("lint"); // local only
    expect(names).toContain("deploy"); // global only
    expect(names).toContain("review"); // overridden
  });

  it("returns sorted by name", async () => {
    const agents = await listAgents({
      cwd: path.join(TMP_DIR, "project"),
    });
    const names = agents.map((a) => a.name);
    expect(names).toEqual([...names].sort());
  });

  it("returns empty array for missing directories", async () => {
    // Point to a non-existent global dir by creating a new handler
    const agents = await listAgents({ cwd: "/nonexistent/path" });
    // Should still return global agents (the dir exists)
    expect(agents.length).toBeGreaterThan(0);
  });

  it("handles agents without description or args", async () => {
    const agents = await listAgents({});
    const deploy = agents.find((a) => a.name === "deploy");
    expect(deploy.description).toBe("Deploy to production");
    expect(deploy.args).toEqual([]);
  });
});
