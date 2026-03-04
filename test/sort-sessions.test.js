import { describe, it, expect } from "vitest";

// Extracted sortSessions from main.js for testing
function sortSessions(sessions) {
  const idle = sessions.filter((s) => s.status === "idle");
  const processing = sessions.filter((s) => s.status === "processing");
  const fresh = sessions.filter((s) => s.status === "fresh");
  const dead = sessions.filter((s) => s.status === "dead");

  idle.sort((a, b) => b.idleTs - a.idleTs);
  processing.sort((a, b) => Number(a.pid) - Number(b.pid));
  fresh.sort((a, b) => Number(b.pid) - Number(a.pid));
  dead.sort((a, b) => Number(b.pid) - Number(a.pid));

  return [...idle, ...processing, ...fresh, ...dead];
}

describe("sortSessions", () => {
  it("sorts idle sessions LIFO (most recently idle first)", () => {
    const sessions = [
      { pid: "100", status: "idle", idleTs: 1000 },
      { pid: "200", status: "idle", idleTs: 3000 },
      { pid: "300", status: "idle", idleTs: 2000 },
    ];
    expect(sortSessions(sessions).map((s) => s.pid)).toEqual([
      "200",
      "300",
      "100",
    ]);
  });

  it("sorts processing sessions by longest running first (lowest PID)", () => {
    const sessions = [
      { pid: "500", status: "processing", idleTs: 0 },
      { pid: "100", status: "processing", idleTs: 0 },
      { pid: "300", status: "processing", idleTs: 0 },
    ];
    expect(sortSessions(sessions).map((s) => s.pid)).toEqual([
      "100",
      "300",
      "500",
    ]);
  });

  it("groups in order: idle → processing → fresh → dead", () => {
    const sessions = [
      { pid: "1", status: "dead", idleTs: 0 },
      { pid: "2", status: "fresh", idleTs: 0 },
      { pid: "3", status: "processing", idleTs: 0 },
      { pid: "4", status: "idle", idleTs: 1000 },
    ];
    expect(sortSessions(sessions).map((s) => s.status)).toEqual([
      "idle",
      "processing",
      "fresh",
      "dead",
    ]);
  });

  it("sorts fresh sessions newest first (highest PID)", () => {
    const sessions = [
      { pid: "100", status: "fresh", idleTs: 0 },
      { pid: "300", status: "fresh", idleTs: 0 },
      { pid: "200", status: "fresh", idleTs: 0 },
    ];
    expect(sortSessions(sessions).map((s) => s.pid)).toEqual([
      "300",
      "200",
      "100",
    ]);
  });

  it("maintains correct internal sorting across mixed groups", () => {
    const sessions = [
      { pid: "500", status: "processing", idleTs: 0 },
      { pid: "100", status: "idle", idleTs: 1000 },
      { pid: "200", status: "idle", idleTs: 3000 },
      { pid: "300", status: "processing", idleTs: 0 },
      { pid: "400", status: "fresh", idleTs: 0 },
      { pid: "600", status: "dead", idleTs: 0 },
    ];
    expect(sortSessions(sessions).map((s) => s.pid)).toEqual([
      "200",
      "100",
      "300",
      "500",
      "400",
      "600",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(sortSessions([])).toEqual([]);
  });

  it("handles a single session", () => {
    const result = sortSessions([{ pid: "1", status: "idle", idleTs: 5000 }]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("idle");
  });
});
