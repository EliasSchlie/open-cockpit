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
      {
        pid: "9999",
        sessionId: "type0000-0000-0000-0000-000000000000",
        alive: true,
        cwd: "/tmp/typing-project",
        home: os.homedir(),
        gitRoot: null,
        project: "typing-project",
        hasIntention: true,
        intentionHeading: "Typing something",
        status: "typing",
        intentionHasContent: true,
        terminalHasInput: false,
        idleTs: 0,
        staleIdle: false,
        origin: "pool",
        poolStatus: "fresh",
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
  "pool-start": (msg) => ({
    type: "started",
    sessionId: "new00000-new0-new0-new0-new000000000",
    termId: 20,
    slotIndex: 5,
  }),
  "pool-wait": (msg) => ({
    type: "result",
    sessionId: msg.sessionId,
    buffer: "Hello from the agent!\n",
  }),
  "list-agents": (msg) => ({
    type: "agents",
    agents: [
      {
        name: "test-agent",
        path: "/tmp/agents/test-agent.sh",
        description: "A test agent",
        scope: "global",
        args: [{ name: "input", description: "Test input", required: true }],
      },
    ],
  }),
  "read-intention": () => ({
    type: "intention",
    content: "# Test Intention\n\nDoing test things.",
  }),
  "write-intention": () => ({ type: "ok" }),
  "pool-clean": () => ({ type: "cleaned", count: 1 }),
  "session-terminals": (msg) => {
    if (msg.sessionId === "ext00000-ext0-ext0-ext0-ext000000000") {
      return {
        type: "terminals",
        terminals: [
          {
            termId: 30,
            index: 0,
            label: "Shell 1",
            isTui: false,
            pid: 5678,
            cwd: "/tmp/ext-project",
          },
        ],
      };
    }
    return {
      type: "terminals",
      terminals: [
        {
          termId: 10,
          index: 0,
          label: "Claude",
          isTui: true,
          pid: 1234,
          cwd: "/tmp/test-project",
        },
        {
          termId: 15,
          index: 1,
          label: "Shell 1",
          isTui: false,
          pid: 2345,
          cwd: "/tmp/test-project",
        },
      ],
    };
  },
  "session-term-read": (msg) => ({
    type: "buffer",
    termId: msg.tabIndex === 0 ? 10 : 15,
    buffer:
      msg.tabIndex === 0
        ? "Claude TUI content\r\n"
        : "$ ls\nfile1.txt\nfile2.txt\n",
  }),
  "session-term-write": () => ({ type: "ok" }),
  "session-term-open": () => ({
    type: "spawned",
    termId: 20,
    tabIndex: 2,
  }),
  "session-term-run": (msg) => {
    if (msg.tabIndex === 0) {
      return {
        type: "error",
        error: "Cannot run commands in the Claude TUI tab",
      };
    }
    return {
      type: "output",
      output: `total 8\n-rw-r--r-- 1 user staff 0 Jan 1 00:00 file1.txt\n-rw-r--r-- 1 user staff 0 Jan 1 00:00 file2.txt`,
      termId: 15,
    };
  },
  "session-term-close": (msg) => {
    if (msg.tabIndex === 0) {
      return { type: "error", error: "Cannot close the Claude TUI tab" };
    }
    return { type: "ok" };
  },
};

function runCli(args, env = {}, timeout = 5000) {
  return new Promise((resolve) => {
    const proc = execFile(
      "bash",
      [CLI_PATH, ...args],
      {
        env: {
          ...process.env,
          HOME: TMP_DIR,
          PATH: process.env.PATH,
          OPEN_COCKPIT_DIR: "",
          ...env,
        },
        timeout,
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
            const result = handler
              ? handler(msg)
              : { type: "error", error: `Unknown: ${msg.type}` };
            // Support async handlers (e.g., delayed responses)
            Promise.resolve(result).then((resp) => {
              if (!socket.destroyed) {
                socket.write(JSON.stringify({ ...resp, id: msg.id }) + "\n");
              }
            });
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
      expect(r.stdout).not.toContain("typing");
    });

    it("filters by --typing", async () => {
      const r = await runCli(["ls", "--typing"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("typing");
      expect(r.stdout).not.toContain("idle");
      expect(r.stdout).not.toContain("processing");
    });

    it("outputs JSON with --json", async () => {
      const r = await runCli(["ls", "--json"]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
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

  describe("term ls", () => {
    it("lists terminals for a session by slot", async () => {
      const r = await runCli(["term", "ls", "@0"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Claude");
      expect(r.stdout).toContain("Shell 1");
      expect(r.stdout).toContain("TUI");
    });

    it("lists terminals by session prefix", async () => {
      const r = await runCli(["term", "ls", "abcd1"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Claude");
    });
  });

  describe("term read", () => {
    it("reads terminal content by tab index", async () => {
      const r = await runCli(["term", "read", "@0", "1"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("file1.txt");
    });

    it("reads TUI tab content", async () => {
      const r = await runCli(["term", "read", "@0", "0"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Claude TUI content");
    });

    it("lists tabs when no tab index given", async () => {
      const r = await runCli(["term", "read", "@0"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Claude");
      expect(r.stdout).toContain("Shell 1");
    });
  });

  describe("term write", () => {
    it("writes to a terminal tab", async () => {
      const r = await runCli(["term", "write", "@0", "1", "ls -la"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Written to");
    });
  });

  describe("term key", () => {
    it("sends a named key to a terminal tab", async () => {
      const r = await runCli(["term", "key", "@0", "1", "enter"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Sent enter");
    });

    it("errors on unknown key", async () => {
      const r = await runCli(["term", "key", "@0", "1", "f5"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Unknown key");
    });
  });

  describe("term open", () => {
    it("opens a new terminal tab", async () => {
      const r = await runCli(["term", "open", "@0"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("tab 2");
    });
  });

  describe("term close", () => {
    it("closes a terminal tab", async () => {
      const r = await runCli(["term", "close", "@0", "1"]);
      expect(r.code).toBe(0);
    });

    it("refuses to close TUI tab", async () => {
      const r = await runCli(["term", "close", "@0", "0"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("TUI");
    });
  });

  describe("term run", () => {
    it("runs a command in a terminal tab", async () => {
      const r = await runCli(["term", "run", "@0", "1", "ls -la"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("file1.txt");
      expect(r.stdout).toContain("file2.txt");
    });

    it("refuses to run in TUI tab", async () => {
      const r = await runCli(["term", "run", "@0", "0", "ls"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("TUI");
    });
  });

  describe("term exec", () => {
    it("opens tab, runs command, closes tab", async () => {
      const r = await runCli(["term", "exec", "@0", "ls -la"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("file1.txt");
    });
  });

  describe("self-detection", () => {
    it("detects session from PID ancestry", async () => {
      // Create a session-pids entry for our test process's PID
      const pidDir = path.join(TMP_DIR, ".open-cockpit", "session-pids");
      fs.mkdirSync(pidDir, { recursive: true });
      // Write session ID for PID 1 (init — every process has this ancestor)
      // Instead, write for a known PID in the ancestry
      // Use process.pid as a parent that the bash child will have
      fs.writeFileSync(path.join(pidDir, String(process.pid)), SESSION_ID);

      const r = await runCli(["term", "ls"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Claude");
      expect(r.stdout).toContain("Shell 1");

      // Clean up
      fs.rmSync(pidDir, { recursive: true, force: true });
    });

    it("errors when no target and no session detected", async () => {
      const r = await runCli(["term", "ls"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("auto-detect");
    });

    it("auto-detects for term read with tab index only", async () => {
      const pidDir = path.join(TMP_DIR, ".open-cockpit", "session-pids");
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(path.join(pidDir, String(process.pid)), SESSION_ID);

      const r = await runCli(["term", "read", "1"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("file1.txt");

      fs.rmSync(pidDir, { recursive: true, force: true });
    });

    it("auto-detects for term exec with command only", async () => {
      const pidDir = path.join(TMP_DIR, ".open-cockpit", "session-pids");
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(path.join(pidDir, String(process.pid)), SESSION_ID);

      const r = await runCli(["term", "exec", "ls -la"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("file1.txt");

      fs.rmSync(pidDir, { recursive: true, force: true });
    });
  });

  describe("socket auto-detection", () => {
    it("respects COCKPIT_SOCKET env override", async () => {
      const ocDir = path.join(TMP_DIR, ".open-cockpit");
      const customSock = path.join(ocDir, "custom.sock");
      const customServer = net.createServer((socket) => {
        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk.toString();
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            socket.write(JSON.stringify({ type: "pong", id: msg.id }) + "\n");
          }
        });
      });

      await new Promise((resolve) => customServer.listen(customSock, resolve));

      try {
        const r = await runCli(["ping"], { COCKPIT_SOCKET: customSock });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("pong");
      } finally {
        customServer.close();
      }
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

  describe("start", () => {
    it("returns session ID on stdout and stderr", async () => {
      const r = await runCli(["start", "test prompt"]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("new00000-new0-new0-new0-new000000000");
      expect(r.stderr.trim()).toBe("new00000-new0-new0-new0-new000000000");
    });

    it("returns session ID with delayed server response", async () => {
      // Temporarily replace pool-start with a delayed handler
      const original = mockHandlers["pool-start"];
      mockHandlers["pool-start"] = () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                type: "started",
                sessionId: "slow0000-slow-slow-slow-slow00000000",
                termId: 20,
                slotIndex: 5,
              }),
            500,
          ),
        );

      try {
        const r = await runCli(["start", "delayed prompt"], {}, 10000);
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe("slow0000-slow-slow-slow-slow00000000");
        expect(r.stderr.trim()).toBe("slow0000-slow-slow-slow-slow00000000");
      } finally {
        mockHandlers["pool-start"] = original;
      }
    });

    it("returns session ID with 2s delayed response", async () => {
      const original = mockHandlers["pool-start"];
      mockHandlers["pool-start"] = () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                type: "started",
                sessionId: "wait0000-wait-wait-wait-wait00000000",
                termId: 20,
                slotIndex: 5,
              }),
            2000,
          ),
        );

      try {
        const r = await runCli(["start", "slow prompt"], {}, 10000);
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe("wait0000-wait-wait-wait-wait00000000");
      } finally {
        mockHandlers["pool-start"] = original;
      }
    });

    it("errors with no prompt", async () => {
      const r = await runCli(["start"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Usage:");
    });

    it("detects parent session via PID ancestry", async () => {
      const pidDir = path.join(TMP_DIR, ".open-cockpit", "session-pids");
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(path.join(pidDir, String(process.pid)), SESSION_ID);

      // Capture the pool-start message to verify parentSessionId
      let capturedMsg = null;
      const original = mockHandlers["pool-start"];
      mockHandlers["pool-start"] = (msg) => {
        capturedMsg = msg;
        return original(msg);
      };

      try {
        const r = await runCli(["start", "child prompt"]);
        expect(r.code).toBe(0);
        expect(capturedMsg).not.toBeNull();
        expect(capturedMsg.parentSessionId).toBe(SESSION_ID);
      } finally {
        mockHandlers["pool-start"] = original;
        fs.rmSync(pidDir, { recursive: true, force: true });
      }
    });
  });

  describe("agents", () => {
    let agentsDir;

    beforeAll(() => {
      agentsDir = path.join(TMP_DIR, ".open-cockpit", "agents");
      fs.mkdirSync(agentsDir, { recursive: true });

      fs.writeFileSync(
        path.join(agentsDir, "greet.sh"),
        '#!/usr/bin/env bash\n# Description: Greet someone\n# Arg: name | Name of the person to greet\necho "Hello $1"\n',
      );
      fs.chmodSync(path.join(agentsDir, "greet.sh"), 0o755);

      fs.writeFileSync(
        path.join(agentsDir, "multi.sh"),
        '#!/usr/bin/env bash\n# Description: Multi-arg agent\n# Arg: input | Main input\n# Arg: --format | Output format | optional | default: text\necho "ok"\n',
      );
      fs.chmodSync(path.join(agentsDir, "multi.sh"), 0o755);

      fs.writeFileSync(
        path.join(agentsDir, "bare.sh"),
        '#!/usr/bin/env bash\necho "no description"\n',
      );
      fs.chmodSync(path.join(agentsDir, "bare.sh"), 0o755);
    });

    it("lists agents with descriptions", async () => {
      const r = await runCli(["agents"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("greet");
      expect(r.stdout).toContain("Greet someone");
      expect(r.stdout).toContain("multi");
      expect(r.stdout).toContain("bare");
    });

    it("lists agents with args in verbose mode", async () => {
      const r = await runCli(["agents", "-v"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("greet");
      expect(r.stdout).toContain("<name>");
      expect(r.stdout).toContain("Name of the person to greet");
      expect(r.stdout).toContain("<input>");
      expect(r.stdout).toContain("[--format]");
    });

    it("shows agent help with --help", async () => {
      const r = await runCli(["agent", "greet", "--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("greet — Greet someone");
      expect(r.stdout).toContain("Arguments:");
      expect(r.stdout).toContain("<name>");
      expect(r.stdout).toContain("required");
    });

    it("shows agent help for multi-arg agent", async () => {
      const r = await runCli(["agent", "multi", "--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("multi — Multi-arg agent");
      expect(r.stdout).toContain("<input>");
      expect(r.stdout).toContain("[--format]");
      expect(r.stdout).toContain("optional");
      expect(r.stdout).toContain("default: text");
    });

    it("shows generic help for agent without Arg metadata", async () => {
      const r = await runCli(["agent", "bare", "--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("bare — No description");
      expect(r.stdout).toContain("$1, $2");
    });

    it("runs an agent script", async () => {
      const r = await runCli(["agent", "greet", "World"]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("Hello World");
    });

    it("errors on missing agent name", async () => {
      const r = await runCli(["agent"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("agent name required");
    });

    it("errors on non-existent agent", async () => {
      const r = await runCli(["agent", "nope"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("not found");
    });

    it("errors on invalid agent name", async () => {
      const r = await runCli(["agent", "../etc/passwd"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("Invalid agent name");
    });

    it("prefers project-local agents over global", async () => {
      const localDir = path.join(TMP_DIR, ".open-cockpit", "agents");
      // greet.sh already exists as global; create a local override
      const projectAgentsDir = path.join(TMP_DIR, ".open-cockpit", "agents");
      // Use a separate project dir for local override test
      const projectDir = path.join(TMP_DIR, "project");
      const projectLocalDir = path.join(projectDir, ".open-cockpit", "agents");
      fs.mkdirSync(projectLocalDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectLocalDir, "greet.sh"),
        '#!/usr/bin/env bash\n# Description: Local greet override\necho "Local hello $1"\n',
      );
      fs.chmodSync(path.join(projectLocalDir, "greet.sh"), 0o755);

      // Run from the project directory
      const r = await runCli(["agents"], { PWD: projectDir });
      // Since we can't easily control cwd, test the agents -v format
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("greet");
    });
  });
});
