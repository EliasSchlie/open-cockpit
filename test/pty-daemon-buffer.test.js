/**
 * Integration tests for the PTY daemon's buffer management.
 *
 * Spawns a real daemon on a temp socket, sends commands over the wire,
 * and verifies buffer behavior — no mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fork } from "child_process";
import net from "net";
import path from "path";
import fs from "fs";
import os from "os";

const DAEMON_PATH = path.resolve("src/pty-daemon.js");
const TMP_DIR = path.join(os.tmpdir(), `oc-daemon-test-${process.pid}`);
const SOCK_PATH = path.join(TMP_DIR, "test-daemon.sock");

let daemon;
let msgId = 0;

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK_PATH, () => resolve(sock));
    sock.on("error", reject);
  });
}

/** Send a message and wait for the response with matching id.
 *  Non-matching messages are stashed on sock._stash for collectEvents. */
function request(sock, msg) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    let buf = "";
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for response to ${msg.type}`)),
      5000,
    );

    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.id === id) {
          clearTimeout(timeout);
          sock.off("data", onData);
          resolve(parsed);
          return;
        }
        // Stash non-matching messages so collectEvents can pick them up
        if (!sock._stash) sock._stash = [];
        sock._stash.push(parsed);
      }
    }

    sock.on("data", onData);
    sock.write(JSON.stringify({ ...msg, id }) + "\n");
  });
}

/** Fire-and-forget: send a message without waiting for a response (e.g. write, resize). */
function send(sock, msg) {
  sock.write(JSON.stringify({ ...msg, id: ++msgId }) + "\n");
}

/** Collect push events (data, replay) for a duration.
 *  Includes any events stashed by request() that arrived before collection started. */
function collectEvents(sock, durationMs = 500) {
  return new Promise((resolve) => {
    // Drain events stashed by request()
    const events = sock._stash ? sock._stash.splice(0) : [];
    let buf = "";

    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        events.push(JSON.parse(line));
      }
    }

    sock.on("data", onData);
    setTimeout(() => {
      sock.off("data", onData);
      resolve(events);
    }, durationMs);
  });
}

beforeAll(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  daemon = fork(DAEMON_PATH, [], {
    env: {
      ...process.env,
      OPEN_COCKPIT_DIR: TMP_DIR,
      PTY_DAEMON_SOCK: SOCK_PATH,
    },
    stdio: "ignore",
  });

  // Wait for socket to be ready
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(SOCK_PATH)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(SOCK_PATH)) {
    throw new Error("Daemon did not start");
  }
});

afterAll(async () => {
  if (daemon) {
    const d = daemon;
    daemon = null;
    d.kill("SIGTERM");
    await new Promise((resolve) => d.on("exit", resolve));
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("clear-buffer command", () => {
  it("clears the replay buffer for a terminal", async () => {
    const sock = await connect();
    try {
      // Spawn a shell that produces known output
      const spawnResp = await request(sock, {
        type: "spawn",
        cmd: "/bin/sh",
        args: ["-c", 'echo "HELLO_BUFFER_TEST"; sleep 10'],
        cols: 80,
        rows: 24,
      });
      const termId = spawnResp.termId;
      expect(termId).toBeGreaterThan(0);

      // Wait for output to accumulate
      await new Promise((r) => setTimeout(r, 300));

      // Verify buffer has content
      const before = await request(sock, { type: "read-buffer", termId });
      expect(before.buffer).toContain("HELLO_BUFFER_TEST");

      // Clear the buffer
      const clearResp = await request(sock, { type: "clear-buffer", termId });
      expect(clearResp.type).toBe("buffer-cleared");

      // Verify buffer is empty
      const after = await request(sock, { type: "read-buffer", termId });
      expect(after.buffer).toBe("");

      await request(sock, { type: "kill", termId });
    } finally {
      sock.destroy();
    }
  });

  it("returns buffer-cleared even for unknown termId", async () => {
    const sock = await connect();
    try {
      const resp = await request(sock, {
        type: "clear-buffer",
        termId: 99999,
      });
      expect(resp.type).toBe("buffer-cleared");
    } finally {
      sock.destroy();
    }
  });
});

describe("buffer after offload simulation", () => {
  it("clear-buffer wipes old content, new output builds fresh buffer", async () => {
    const sock = await connect();
    try {
      // Spawn a long-running shell
      const spawnResp = await request(sock, {
        type: "spawn",
        cmd: "/bin/sh",
        cols: 80,
        rows: 24,
      });
      const termId = spawnResp.termId;

      // Attach so we receive data events
      await request(sock, { type: "attach", termId });

      // Produce "old session" output
      send(sock, {
        type: "write",
        termId,
        data: 'echo "OLD_SESSION_CONTENT"\n',
      });
      await new Promise((r) => setTimeout(r, 300));

      // Verify old content is in buffer
      let buf = await request(sock, { type: "read-buffer", termId });
      expect(buf.buffer).toContain("OLD_SESSION_CONTENT");

      // Simulate offload: clear the buffer (like pool-manager does after /clear)
      await request(sock, { type: "clear-buffer", termId });

      // Produce "new session" output
      send(sock, {
        type: "write",
        termId,
        data: 'echo "NEW_SESSION_CONTENT"\n',
      });
      await new Promise((r) => setTimeout(r, 300));

      // Verify: buffer has new content but NOT old content
      buf = await request(sock, { type: "read-buffer", termId });
      expect(buf.buffer).toContain("NEW_SESSION_CONTENT");
      expect(buf.buffer).not.toContain("OLD_SESSION_CONTENT");

      await request(sock, { type: "kill", termId });
    } finally {
      sock.destroy();
    }
  });
});

describe("replay after clear-buffer", () => {
  it("attach after clear-buffer replays only new content", async () => {
    const sock1 = await connect();
    let sock2;
    try {
      // Spawn and produce old output
      const spawnResp = await request(sock1, {
        type: "spawn",
        cmd: "/bin/sh",
        args: ["-c", 'echo "STALE_DATA"; sleep 10'],
        cols: 80,
        rows: 24,
      });
      const termId = spawnResp.termId;
      await new Promise((r) => setTimeout(r, 300));

      // Clear buffer (simulating offload)
      await request(sock1, { type: "clear-buffer", termId });

      // Write new content directly
      send(sock1, { type: "write", termId, data: 'echo "FRESH_DATA"\n' });
      await new Promise((r) => setTimeout(r, 300));

      // New client attaches — should get replay of only new content
      sock2 = await connect();
      const attachResp = await request(sock2, { type: "attach", termId });
      expect(attachResp.type).toBe("attached");

      // Collect the replay event
      const events = await collectEvents(sock2, 300);
      const replayEvent = events.find((e) => e.type === "replay");

      expect(replayEvent, "Expected a replay event after attach").toBeDefined();
      expect(replayEvent.data).toContain("FRESH_DATA");
      expect(replayEvent.data).not.toContain("STALE_DATA");

      await request(sock1, { type: "kill", termId });
    } finally {
      sock1.destroy();
      if (sock2) sock2.destroy();
    }
  });
});

describe("ANSI-aware buffer trim", () => {
  it("does not corrupt terminal state with truncated escape sequences", async () => {
    const sock = await connect();
    try {
      // Spawn a shell
      const spawnResp = await request(sock, {
        type: "spawn",
        cmd: "/bin/sh",
        cols: 80,
        rows: 24,
      });
      const termId = spawnResp.termId;
      await request(sock, { type: "attach", termId });

      // Produce enough output to trigger buffer trim (>200KB).
      // Include ANSI escapes that could be split at the trim boundary.
      // Each line is ~110 chars, need ~2000 lines for 200KB.
      const ansiLine =
        "\x1b[32mGREEN\x1b[0m \x1b[?25h\x1b[1;1H" + "X".repeat(80) + "\n";
      const batch = ansiLine.repeat(100);
      for (let i = 0; i < 25; i++) {
        send(sock, { type: "write", termId, data: batch });
      }
      await new Promise((r) => setTimeout(r, 500));

      // Read the trimmed buffer
      const buf = await request(sock, { type: "read-buffer", termId });

      // Verify trim actually fired — buffer should be <= BUFFER_SIZE (100KB)
      // We wrote ~275KB, so it must have been trimmed
      expect(buf.buffer.length).toBeLessThanOrEqual(100_000);
      expect(buf.buffer.length).toBeGreaterThan(0);

      // The buffer should not start with a partial escape sequence.
      // A partial would be \x1b followed by [ but no final letter.
      const firstEsc = buf.buffer.indexOf("\x1b");
      if (firstEsc >= 0 && firstEsc < 40) {
        const seq = buf.buffer.substring(firstEsc, firstEsc + 20);
        // If it starts with ESC[, there must be a final byte (letter) before the next ESC or content
        if (seq.startsWith("\x1b[")) {
          const finalMatch = seq.match(/^\x1b\[[\x20-\x3f]*([\x40-\x7e])/);
          expect(
            finalMatch,
            `Buffer starts with incomplete CSI sequence: ${JSON.stringify(seq.slice(0, 15))}`,
          ).toBeTruthy();
        }
      }

      await request(sock, { type: "kill", termId });
    } finally {
      sock.destroy();
    }
  });

  it("handles DEC private mode sequences correctly", async () => {
    const sock = await connect();
    try {
      const spawnResp = await request(sock, {
        type: "spawn",
        cmd: "/bin/sh",
        cols: 80,
        rows: 24,
      });
      const termId = spawnResp.termId;
      await request(sock, { type: "attach", termId });

      // Fill buffer past trim threshold with DEC private mode sequences
      // These use ? prefix which naive regex would misparse
      const decLine = "\x1b[?25h\x1b[?1049h\x1b[?25l" + "Y".repeat(80) + "\n";
      const batch = decLine.repeat(100);
      for (let i = 0; i < 25; i++) {
        send(sock, { type: "write", termId, data: batch });
      }
      await new Promise((r) => setTimeout(r, 500));

      const buf = await request(sock, { type: "read-buffer", termId });

      // Verify trim fired and content is valid
      expect(buf.buffer.length).toBeLessThanOrEqual(100_000);
      expect(buf.buffer.length).toBeGreaterThan(0);
      expect(buf.buffer).toContain("YYYYY");

      await request(sock, { type: "kill", termId });
    } finally {
      sock.destroy();
    }
  });
});
