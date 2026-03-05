import { describe, it, expect } from "vitest";
import { sortSessions } from "../src/sort-sessions";

describe("sortSessions", () => {
  it("sorts recent (idle+offloaded) by most recently used first", () => {
    const sessions = [
      { pid: "100", status: "idle", idleTs: 1000, isPool: true },
      { pid: "200", status: "offloaded", idleTs: 3000, isPool: true },
      { pid: "300", status: "idle", idleTs: 2000, isPool: false },
    ];
    expect(sortSessions(sessions).map((s) => s.pid)).toEqual([
      "200",
      "300",
      "100",
    ]);
  });

  it("sorts processing by longest running first (lowest PID)", () => {
    const sessions = [
      { pid: "500", status: "processing", idleTs: 0, isPool: true },
      { pid: "100", status: "processing", idleTs: 0, isPool: false },
      { pid: "300", status: "processing", idleTs: 0, isPool: true },
    ];
    expect(sortSessions(sessions).map((s) => s.pid)).toEqual([
      "100",
      "300",
      "500",
    ]);
  });

  it("groups: recent → processing → fresh → dead → archived (pool+external mixed)", () => {
    const sessions = [
      { pid: "1", status: "dead", idleTs: 0, isPool: false },
      { pid: "2", status: "fresh", idleTs: 0, isPool: true },
      { pid: "3", status: "processing", idleTs: 0, isPool: true },
      { pid: "4", status: "idle", idleTs: 1000, isPool: true },
      { pid: "5", status: "offloaded", idleTs: 500, isPool: true },
      { pid: "6", status: "idle", idleTs: 800, isPool: false },
      { pid: "7", status: "archived", idleTs: 200, isPool: true },
      { pid: "8", status: "archived", idleTs: 600, isPool: false },
    ];
    const result = sortSessions(sessions);
    expect(result.map((s) => s.pid)).toEqual([
      "4", // recent (idle, ts=1000)
      "6", // recent (idle, ts=800, external)
      "5", // recent (offloaded, ts=500)
      "3", // processing
      "2", // fresh
      "1", // dead
      "8", // archived (ts=600)
      "7", // archived (ts=200)
    ]);
  });

  it("limits recent section to 10 sessions", () => {
    const sessions = Array.from({ length: 15 }, (_, i) => ({
      pid: String(i),
      status: "idle",
      idleTs: i * 100,
      isPool: true,
    }));
    const result = sortSessions(sessions);
    const recent = result.filter((s) => s.status === "idle");
    expect(recent).toHaveLength(10);
    expect(recent[0].idleTs).toBe(1400);
    expect(recent[9].idleTs).toBe(500);
  });

  it("returns empty array for empty input", () => {
    expect(sortSessions([])).toEqual([]);
  });

  it("handles a single session", () => {
    const result = sortSessions([
      { pid: "1", status: "idle", idleTs: 5000, isPool: true },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("idle");
  });
});
