import { describe, it, expect } from "vitest";

// --- Extracted logic from renderer.js for testing ---

// Session switching: given current index, direction, and list length, compute next index
function computeNextSessionIndex(currentId, sessions, direction) {
  if (sessions.length === 0) return -1;
  const currentIndex = sessions.findIndex((s) => s.sessionId === currentId);
  if (currentIndex === -1) return 0;
  return (currentIndex + direction + sessions.length) % sessions.length;
}

// formatShortcutDisplay (mirrors renderer.js)
function formatShortcutDisplay(accel) {
  if (!accel) return "";
  return accel
    .replace(/CmdOrCtrl\+/gi, "\u2318")
    .replace(/Cmd\+/gi, "\u2318")
    .replace(/Ctrl\+/gi, "\u2303")
    .replace(/Shift\+/gi, "\u21E7")
    .replace(/Alt\+/gi, "\u2325")
    .replace(/\+/g, "")
    .replace(/Tab/gi, "\u21E5")
    .replace(/Up/gi, "\u2191")
    .replace(/Down/gi, "\u2193")
    .replace(/Left/gi, "\u2190")
    .replace(/Right/gi, "\u2192");
}

// Shortcut config (default values for testing)
const shortcutConfig = {
  "next-session": "Alt+Down",
  "prev-session": "Alt+Up",
  "new-session": "CmdOrCtrl+N",
  "new-terminal-tab": "CmdOrCtrl+T",
  "close-terminal-tab": "CmdOrCtrl+W",
  "next-tab": "CmdOrCtrl+Shift+]",
  "prev-tab": "CmdOrCtrl+Shift+[",
  "toggle-sidebar": "CmdOrCtrl+\\",
  "focus-editor": "CmdOrCtrl+E",
  "focus-terminal": "CmdOrCtrl+`",
  "toggle-command-palette": "CmdOrCtrl+/",
  "cycle-pane": "CmdOrCtrl+Shift+Tab",
  "toggle-pane-focus": "",
};

function getCommandShortcut(cmd) {
  if (!cmd.shortcutAction) return "";
  return formatShortcutDisplay(shortcutConfig[cmd.shortcutAction] || "");
}

// Command filtering logic (mirrors renderPaletteList)
function filterCommands(commands, query) {
  const q = query.toLowerCase();
  if (!q) return commands.filter((c) => !c.id.startsWith("tab-"));
  return commands.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      getCommandShortcut(c).toLowerCase().includes(q),
  );
}

// Sample command list matching renderer.js structure
const COMMANDS = [
  { id: "next-session", label: "Next Session", shortcutAction: "next-session" },
  {
    id: "prev-session",
    label: "Previous Session",
    shortcutAction: "prev-session",
  },
  {
    id: "new-session",
    label: "New Claude Session",
    shortcutAction: "new-session",
  },
  {
    id: "new-terminal",
    label: "New Terminal Tab",
    shortcutAction: "new-terminal-tab",
  },
  {
    id: "close-terminal",
    label: "Close Terminal Tab",
    shortcutAction: "close-terminal-tab",
  },
  { id: "next-tab", label: "Next Terminal Tab", shortcutAction: "next-tab" },
  {
    id: "prev-tab",
    label: "Previous Terminal Tab",
    shortcutAction: "prev-tab",
  },
  {
    id: "toggle-sidebar",
    label: "Toggle Sidebar",
    shortcutAction: "toggle-sidebar",
  },
  { id: "cycle-pane", label: "Cycle Pane Focus", shortcutAction: "cycle-pane" },
  { id: "focus-editor", label: "Focus Editor", shortcutAction: "focus-editor" },
  {
    id: "focus-terminal",
    label: "Focus Terminal",
    shortcutAction: "focus-terminal",
  },
  { id: "refresh", label: "Refresh Sessions" },
  {
    id: "command-palette",
    label: "Command Palette",
    shortcutAction: "toggle-command-palette",
  },
  { id: "tab-1", label: "Switch to Tab 1" },
  { id: "tab-2", label: "Switch to Tab 2" },
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
    expect(result.length).toBe(13); // All except tab-1, tab-2
  });

  it("filters by label substring", () => {
    const result = filterCommands(COMMANDS, "terminal");
    expect(result.length).toBe(5); // New/Close/Next/Prev Terminal Tab + Focus Terminal
    expect(
      result.every((c) => c.label.toLowerCase().includes("terminal")),
    ).toBe(true);
  });

  it("filters by shortcut display", () => {
    const result = filterCommands(COMMANDS, "\u2325"); // ⌥ (Alt symbol)
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

describe("formatShortcutDisplay", () => {
  it("converts CmdOrCtrl+N to symbol", () => {
    expect(formatShortcutDisplay("CmdOrCtrl+N")).toBe("\u2318N");
  });

  it("converts Alt+Down to symbol", () => {
    expect(formatShortcutDisplay("Alt+Down")).toBe("\u2325\u2193");
  });

  it("converts CmdOrCtrl+Shift+Tab", () => {
    expect(formatShortcutDisplay("CmdOrCtrl+Shift+Tab")).toBe(
      "\u2318\u21E7\u21E5",
    );
  });

  it("returns empty string for empty input", () => {
    expect(formatShortcutDisplay("")).toBe("");
  });
});
