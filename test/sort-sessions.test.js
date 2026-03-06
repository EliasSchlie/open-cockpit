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

  it("places overflow recent sessions after archived", () => {
    const sessions = Array.from({ length: 15 }, (_, i) => ({
      pid: String(i),
      status: "idle",
      idleTs: i * 100,
      isPool: true,
    }));
    const result = sortSessions(sessions);
    // All 15 idle sessions should be present (no longer dropped)
    const recent = result.filter((s) => s.status === "idle");
    expect(recent).toHaveLength(15);
    // First 10 sorted by most recent
    expect(result[0].idleTs).toBe(1400);
    expect(result[9].idleTs).toBe(500);
    // Overflow (5) placed after the top 10
    expect(result[10].idleTs).toBe(400);
    expect(result[14].idleTs).toBe(0);
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

  it("places typing sessions before all other sections", () => {
    const sessions = [
      { pid: "1", status: "idle", idleTs: 1000, isPool: true },
      { pid: "2", status: "typing", idleTs: 0, isPool: true },
      { pid: "3", status: "processing", idleTs: 0, isPool: true },
      { pid: "4", status: "fresh", idleTs: 0, isPool: true },
      { pid: "5", status: "typing", idleTs: 0, isPool: true },
    ];
    const result = sortSessions(sessions);
    expect(result.map((s) => s.pid)).toEqual(["2", "5", "1", "3", "4"]);
  });

  it("does not include typing sessions in recent cap", () => {
    const sessions = [
      { pid: "t1", status: "typing", idleTs: 0, isPool: true },
      ...Array.from({ length: 12 }, (_, i) => ({
        pid: String(i),
        status: "idle",
        idleTs: i * 100,
        isPool: true,
      })),
    ];
    const result = sortSessions(sessions);
    // typing (1) + all 12 recent (10 top + 2 overflow) = 13 total
    expect(result).toHaveLength(13);
    expect(result[0].pid).toBe("t1");
  });
});
