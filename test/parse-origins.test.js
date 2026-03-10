import { describe, it, expect } from "vitest";
import {
  parseOrigins,
  extractInstanceDir,
  parseInstanceDirs,
} from "../src/parse-origins.js";

// Realistic ps eww output (macOS right-aligns PIDs with variable whitespace)
const PS_OUTPUT = `  PID   TT  STAT      TIME COMMAND
12345   ??  S      0:01.23 /usr/bin/claude --some-flag OPEN_COCKPIT_POOL=1 OTHER=stuff
23456   ??  S      0:00.50 /usr/bin/claude --flag SUB_CLAUDE=1 PATH=/usr/bin
34567   ??  S      0:02.00 /usr/bin/claude --flag PATH=/usr/bin HOME=/Users/test`;

// Short PIDs are right-aligned with leading spaces
const PS_SHORT_PIDS = `  PID   TT  STAT      TIME COMMAND
    1   ??  Ss    91:57.04 /sbin/launchd OPEN_COCKPIT_POOL=1
  456   ??  S      0:00.50 /usr/bin/claude SUB_CLAUDE=1`;

describe("parseOrigins", () => {
  it("detects pool origin from OPEN_COCKPIT_POOL=1", () => {
    const result = parseOrigins(PS_OUTPUT, ["12345"]);
    expect(result.get("12345")).toBe("pool");
  });

  it("detects sub-claude origin from SUB_CLAUDE=1", () => {
    const result = parseOrigins(PS_OUTPUT, ["23456"]);
    expect(result.get("23456")).toBe("sub-claude");
  });

  it("defaults to ext when no env markers found", () => {
    const result = parseOrigins(PS_OUTPUT, ["34567"]);
    expect(result.get("34567")).toBe("ext");
  });

  it("defaults to ext when PID not found in output", () => {
    const result = parseOrigins(PS_OUTPUT, ["99999"]);
    expect(result.get("99999")).toBe("ext");
  });

  it("handles multiple PIDs in one call", () => {
    const result = parseOrigins(PS_OUTPUT, ["12345", "23456", "34567"]);
    expect(result.get("12345")).toBe("pool");
    expect(result.get("23456")).toBe("sub-claude");
    expect(result.get("34567")).toBe("ext");
  });

  it("handles empty output", () => {
    const result = parseOrigins("", ["12345"]);
    expect(result.get("12345")).toBe("ext");
  });

  it("handles empty PID list", () => {
    const result = parseOrigins(PS_OUTPUT, []);
    expect(result.size).toBe(0);
  });

  it("does not false-match partial PID", () => {
    // PID 1234 should not match a line starting with 12345
    const result = parseOrigins(PS_OUTPUT, ["1234"]);
    expect(result.get("1234")).toBe("ext");
  });

  it("handles right-aligned short PIDs with leading spaces", () => {
    const result = parseOrigins(PS_SHORT_PIDS, ["1", "456"]);
    expect(result.get("1")).toBe("pool");
    expect(result.get("456")).toBe("sub-claude");
  });
});

describe("extractInstanceDir", () => {
  it("extracts OPEN_COCKPIT_DIR from env string", () => {
    const dir = extractInstanceDir(
      "OPEN_COCKPIT_POOL=1 OPEN_COCKPIT_DIR=/home/user/.open-cockpit-dev/feature-x OTHER=1",
    );
    expect(dir).toBe("/home/user/.open-cockpit-dev/feature-x");
  });

  it("returns null when not present", () => {
    const dir = extractInstanceDir("OPEN_COCKPIT_POOL=1 PATH=/usr/bin");
    expect(dir).toBeNull();
  });
});

describe("parseInstanceDirs", () => {
  const PS_WITH_DIRS = `  PID   TT  STAT      TIME COMMAND
12345   ??  S      0:01.23 /usr/bin/claude OPEN_COCKPIT_DIR=/tmp/dev-1 OPEN_COCKPIT_POOL=1
23456   ??  S      0:00.50 /usr/bin/claude PATH=/usr/bin`;

  it("extracts instance dir for tagged processes", () => {
    const result = parseInstanceDirs(PS_WITH_DIRS, ["12345"]);
    expect(result.get("12345")).toBe("/tmp/dev-1");
  });

  it("returns null for untagged processes", () => {
    const result = parseInstanceDirs(PS_WITH_DIRS, ["23456"]);
    expect(result.get("23456")).toBeNull();
  });
});
