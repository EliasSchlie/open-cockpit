import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";

const TMP_DIR = path.join(os.tmpdir(), "cockpit-cli-test-" + process.pid);
const SOCKET_PATH = path.join(TMP_DIR, "test-api.sock");
const CLI_PATH = path.resolve("bin/cockpit-cli");
const JSONL_DIR = path.join(TMP_DIR, "claude-projects", "-test");
const SESSION_ID = "abcd1234-abcd-abcd-abcd-abcd12345678";

// Mock responses keyed by message type
const mockHandlers = {
  ping: () => ({ type: "pong" }),
  "get-sessions": () => ({
    type: "sessions",
    sessions: [
      {
        pid: "1234",
        sessionId: SESSION_ID,
        alive: true,
        cwd: "/tmp/test-project",
        home: os.homedir(),
        gitRoot: null,
        project: "test-project",
        hasIntention: true,
        intentionHeading: "Test intention heading",
        status: "idle",
        idleTs: 1000,
        staleIdle: false,
        origin: "pool",
        poolStatus: "idle",
      },
      {
        pid: "5678",
        sessionId: "ext00000-ext0-ext0-ext0-ext000000000",
        alive: true,
        cwd: "/tmp/ext-project",
        home: os.homedir(),
        gitRoot: null,
        project: "ext-project",
        hasIntention: false,
        intentionHeading: null,
        status: "processing",
        idleTs: 0,
        staleIdle: false,
        origin: "ext",
      },
    ],
  }),
  "pool-health": () => ({
    type: "health",
    health: {
      initialized: true,
      poolSize: 2,
      slots: [
        {
          index: 0,
          termId: 10,
          pid: 1234,
          status: "idle",
          sessionId: SESSION_ID,
          healthStatus: "idle",
          intentionHeading: "Test intention heading",
          cwd: "/tmp/test-project",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          index: 1,
          termId: 11,
          pid: 5679,
          status: "fresh",
          sessionId: "fresh000-0000-0000-0000-000000000000",
          healthStatus: "fresh",
          intentionHeading: null,
          cwd: "/tmp",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      counts: { idle: 1, processing: 0, fresh: 1 },
    },
  }),
  "pool-capture": (msg) => {
    if (
      msg.sessionId === "ext00000-ext0-ext0-ext0-ext000000000" ||
      (!msg.sessionId && !msg.slotIndex && msg.slotIndex !== 0)
    ) {
      return { type: "error", error: "No slot found for session" };
    }
    return {
      type: "buffer",
      sessionId: msg.sessionId || SESSION_ID,
      slotIndex: msg.slotIndex ?? 0,
      buffer: "Hello from \x1b[32mClaude\x1b[0m!\r\n> ",
    };
  },
  "slot-read": (msg) => ({
    type: "buffer",
    slotIndex: msg.slotIndex,
    sessionId: SESSION_ID,
    buffer: "Hello from \x1b[32mClaude\x1b[0m!\r\n> ",
  }),
  "slot-write": () => ({ type: "ok" }),
  "slot-status": (msg) => ({
    type: "slot",
    slot: {
      index: msg.slotIndex,
      termId: 10,
      pid: 1234,
      status: "idle",
      sessionId: SESSION_ID,
      healthStatus: "idle",
      createdAt: "2026-01-01T00:00:00Z",
    },
  }),
  "pool-input": (msg) => {
    if (msg.sessionId === "ext00000-ext0-ext0-ext0-ext000000000") {
      return { type: "error", error: "No slot found for session" };
    }
    return { type: "ok" };
  },
  "pool-followup": (msg) => {
    if (msg.sessionId === "ext00000-ext0-ext0-ext0-ext000000000") {
      return { type: "error", error: "No slot found for session" };
    }
    return {
      type: "started",
      sessionId: msg.sessionId,
      termId: 10,
      slotIndex: 0,
    };
  },
  "read-intention": () => ({
    type: "intention",
    content: "# Test Intention\n\nDoing test things.",
  }),
  "write-intention": () => ({ type: "ok" }),
  "pool-clean": () => ({ type: "cleaned", count: 1 }),
};

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const proc = execFile(
      "bash",
      [CLI_PATH, ...args],
      {
        env: {
          ...process.env,
          HOME: TMP_DIR,
          PATH: process.env.PATH,
          ...env,
        },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code || 1 : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

let server;

beforeAll(async () => {
  fs.mkdirSync(path.join(TMP_DIR, ".open-cockpit"), { recursive: true });

  // Create mock JSONL transcript
  fs.mkdirSync(JSONL_DIR, { recursive: true });
  const jsonlPath = path.join(JSONL_DIR, `${SESSION_ID}.jsonl`);
  const entries = [
    {
      type: "user",
      message: { content: "Fix the login bug" },
      timestamp: "2026-01-01T00:00:00Z",
      uuid: "u1",
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I'll fix the login bug now." }],
      },
      timestamp: "2026-01-01T00:01:00Z",
      uuid: "a1",
    },
    {
      type: "progress",
      data: { type: "bash_progress" },
      timestamp: "2026-01-01T00:01:30Z",
      uuid: "p1",
    },
    {
      type: "user",
      message: { content: "" },
      timestamp: "2026-01-01T00:02:00Z",
      uuid: "u2",
    },
    {
      type: "user",
      message: { content: "Now add tests" },
      timestamp: "2026-01-01T00:03:00Z",
      uuid: "u3",
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Sure, adding tests." }],
      },
      timestamp: "2026-01-01T00:04:00Z",
      uuid: "a2",
    },
  ];
  fs.writeFileSync(
    jsonlPath,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  // Start mock server
  const socketPath = path.join(TMP_DIR, ".open-cockpit", "api.sock");
  await new Promise((resolve) => {
    server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const handler = mockHandlers[msg.type];
            const resp = handler
              ? handler(msg)
              : { type: "error", error: `Unknown: ${msg.type}` };
            socket.write(JSON.stringify({ ...resp, id: msg.id }) + "\n");
          } catch {
            socket.write(
              JSON.stringify({ type: "error", error: "parse error" }) + "\n",
            );
          }
        }
      });
    });
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("cockpit-cli", () => {
  describe("ls", () => {
    it("shows live sessions in table format", async () => {
      const r = await runCli(["ls"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SLOT");
      expect(r.stdout).toContain("STATUS");
      expect(r.stdout).toContain("test-project");
      expect(r.stdout).toContain("idle");
      expect(r.stdout).toContain("@0");
      expect(r.stdout).toContain("Test intention heading");
    });

    it("filters by --processing", async () => {
      const r = await runCli(["ls", "--processing"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("processing");
      expect(r.stdout).not.toContain("idle");
    });

    it("filters by --idle", async () => {
      const r = await runCli(["ls", "--idle"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("idle");
      expect(r.stdout).not.toContain("processing");
    });

    it("outputs JSON with --json", async () => {
      const r = await runCli(["ls", "--json"]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });
  });

  describe("screen", () => {
    it("shows ANSI-stripped terminal content by slot", async () => {
      const r = await runCli(["screen", "@0"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Hello from Claude!");
      // ANSI should be stripped
      expect(r.stdout).not.toContain("\x1b[32m");
    });

    it("shows raw terminal content with --raw", async () => {
      const r = await runCli(["screen", "@0", "--raw"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("\x1b[32m");
    });

    it("resolves session prefix", async () => {
      const r = await runCli(["screen", "abcd1"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Hello from Claude!");
    });

    it("errors on external session", async () => {
      const r = await runCli(["screen", "ext00"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("external");
    });

    it("errors on unknown prefix", async () => {
      const r = await runCli(["screen", "zzzzz"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("no session matching");
    });
  });

  describe("log", () => {
    it("shows conversation turns", async () => {
      const r = await runCli(["log", "abcd1"], {
        CLAUDE_PROJECTS_DIR: path.join(TMP_DIR, "claude-projects"),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(">>> USER:");
      expect(r.stdout).toContain("Fix the login bug");
      expect(r.stdout).toContain("<<< ASSISTANT:");
      expect(r.stdout).toContain("fix the login bug now");
    });

    it("filters empty user messages (tool approvals)", async () => {
      const r = await runCli(["log", "abcd1"], {
        CLAUDE_PROJECTS_DIR: path.join(TMP_DIR, "claude-projects"),
      });
      // Count USER entries — should be 2 (not 3, empty one filtered)
      const userCount = (r.stdout.match(/>>> USER:/g) || []).length;
      expect(userCount).toBe(2);
    });
  });

  describe("intention", () => {
    it("reads intention", async () => {
      const r = await runCli(["intention", "abcd1"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Test Intention");
    });

    it("writes intention", async () => {
      const r = await runCli(["intention", "abcd1", "New intention"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Intention updated");
    });
  });

  describe("key", () => {
    it("sends named key by slot", async () => {
      const r = await runCli(["key", "@0", "enter"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Sent enter");
    });

    it("errors on unknown key", async () => {
      const r = await runCli(["key", "@0", "f5"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Unknown key");
      expect(r.stderr).toContain("Available:");
    });

    it("errors on external session", async () => {
      const r = await runCli(["key", "ext00", "enter"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("external");
    });
  });

  describe("type", () => {
    it("types text into slot", async () => {
      const r = await runCli(["type", "@0", "hello"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Typed into @0");
    });

    it("errors on external session", async () => {
      const r = await runCli(["type", "ext00", "hello"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("external");
    });
  });

  describe("prompt", () => {
    it("sends prompt to idle session", async () => {
      const r = await runCli(["prompt", "@0", "do something"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Prompt sent");
    });

    it("errors on external session", async () => {
      const r = await runCli(["prompt", "ext00", "do something"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("external");
    });

    it("errors with no text", async () => {
      const r = await runCli(["prompt", "@0"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Usage:");
    });
  });

  describe("prefix resolution", () => {
    it("resolves unique prefix", async () => {
      const r = await runCli(["screen", "abcd"]);
      expect(r.code).toBe(0);
    });

    it("errors on no match", async () => {
      const r = await runCli(["screen", "zzzzz"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("no session matching");
    });
  });

  describe("clean", () => {
    it("reports cleaned count", async () => {
      const r = await runCli(["clean"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Cleaned 1 session(s)");
    });
  });

  describe("ping", () => {
    it("returns pong", async () => {
      const r = await runCli(["ping"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("pong");
    });
  });

  describe("help", () => {
    it("shows help text", async () => {
      const r = await runCli(["help"]);
      expect(r.stderr).toContain("OBSERVE");
      expect(r.stderr).toContain("INTERACT");
      expect(r.stderr).toContain("EXAMPLES");
    });

    it("shows help on unknown command", async () => {
      const r = await runCli(["badcommand"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Unknown command: badcommand");
    });
  });
});
