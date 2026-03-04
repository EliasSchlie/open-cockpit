import { describe, it, expect } from "vitest";

// --- Extracted logic from renderer.js for testing ---

// Session switching: given current index, direction, and list length, compute next index
function computeNextSessionIndex(currentId, sessions, direction) {
  if (sessions.length === 0) return -1;
  const currentIndex = sessions.findIndex((s) => s.sessionId === currentId);
  if (currentIndex === -1) return 0;
  return (currentIndex + direction + sessions.length) % sessions.length;
}

// Command filtering logic (mirrors renderPaletteList)
function filterCommands(commands, query) {
  const q = query.toLowerCase();
  if (!q) return commands.filter((c) => !c.id.startsWith("tab-"));
  return commands.filter(
    (c) =>
      c.label.toLowerCase().includes(q) || c.shortcut.toLowerCase().includes(q),
  );
}

// Sample command list matching renderer.js structure
const COMMANDS = [
  { id: "next-session", label: "Next Session", shortcut: "Alt+↓" },
  { id: "prev-session", label: "Previous Session", shortcut: "Alt+↑" },
  { id: "new-session", label: "New Claude Session", shortcut: "⌘N" },
  { id: "new-terminal", label: "New Terminal Tab", shortcut: "⌘T" },
  { id: "close-terminal", label: "Close Terminal Tab", shortcut: "⌘W" },
  { id: "next-tab", label: "Next Terminal Tab", shortcut: "⌘⇧]" },
  { id: "prev-tab", label: "Previous Terminal Tab", shortcut: "⌘⇧[" },
  { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "⌘\\" },
  { id: "focus-editor", label: "Focus Editor", shortcut: "⌘E" },
  { id: "focus-terminal", label: "Focus Terminal", shortcut: "⌘`" },
  { id: "refresh", label: "Refresh Sessions", shortcut: "" },
  { id: "command-palette", label: "Command Palette", shortcut: "⌘/" },
  { id: "tab-1", label: "Switch to Tab 1", shortcut: "⌘1" },
  { id: "tab-2", label: "Switch to Tab 2", shortcut: "⌘2" },
];

describe("Session switching", () => {
  const sessions = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];

  it("moves to next session", () => {
    expect(computeNextSessionIndex("a", sessions, 1)).toBe(1);
    expect(computeNextSessionIndex("b", sessions, 1)).toBe(2);
  });

  it("wraps around forward", () => {
    expect(computeNextSessionIndex("c", sessions, 1)).toBe(0);
  });

  it("moves to previous session", () => {
    expect(computeNextSessionIndex("b", sessions, -1)).toBe(0);
    expect(computeNextSessionIndex("c", sessions, -1)).toBe(1);
  });

  it("wraps around backward", () => {
    expect(computeNextSessionIndex("a", sessions, -1)).toBe(2);
  });

  it("defaults to index 0 when current session not found", () => {
    expect(computeNextSessionIndex("unknown", sessions, 1)).toBe(0);
    expect(computeNextSessionIndex(null, sessions, -1)).toBe(0);
  });

  it("returns -1 for empty session list", () => {
    expect(computeNextSessionIndex("a", [], 1)).toBe(-1);
  });
});

describe("Command palette filtering", () => {
  it("returns all non-tab commands when query is empty", () => {
    const result = filterCommands(COMMANDS, "");
    expect(result.every((c) => !c.id.startsWith("tab-"))).toBe(true);
    expect(result.length).toBe(12); // All except tab-1, tab-2
  });

  it("filters by label substring", () => {
    const result = filterCommands(COMMANDS, "terminal");
    expect(result.length).toBe(5); // New/Close/Next/Prev Terminal Tab + Focus Terminal
    expect(
      result.every((c) => c.label.toLowerCase().includes("terminal")),
    ).toBe(true);
  });

  it("filters by shortcut", () => {
    const result = filterCommands(COMMANDS, "alt");
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("next-session");
    expect(result[1].id).toBe("prev-session");
  });

  it("is case insensitive", () => {
    const result = filterCommands(COMMANDS, "SIDEBAR");
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("toggle-sidebar");
  });

  it("includes tab commands when they match query", () => {
    const result = filterCommands(COMMANDS, "tab 1");
    expect(result.some((c) => c.id === "tab-1")).toBe(true);
  });

  it("returns empty array when nothing matches", () => {
    const result = filterCommands(COMMANDS, "xyznonexistent");
    expect(result).toEqual([]);
  });

  it("matches partial label", () => {
    const result = filterCommands(COMMANDS, "pal");
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("command-palette");
  });
});

describe("Command list completeness", () => {
  it("has unique IDs", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every command has a label", () => {
    for (const cmd of COMMANDS) {
      expect(cmd.label).toBeTruthy();
    }
  });
});
