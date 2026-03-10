import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { createTestEnv } from "./helpers/test-env.js";

let env;
let shortcuts;

function loadModule() {
  return env.requireFresh("shortcuts.js");
}

describe("Shortcut config system", () => {
  beforeEach(() => {
    env = createTestEnv();
    shortcuts = loadModule();
    shortcuts.loadShortcuts();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("returns default shortcuts when no config file exists", () => {
    const all = shortcuts.getAllShortcuts();
    expect(all["new-session"]).toBe("CmdOrCtrl+N");
    expect(all["toggle-pane-focus"]).toBe("");
    expect(all["cycle-pane"]).toBe("CmdOrCtrl+Shift+Tab");
  });

  it("getShortcut returns default for unknown action", () => {
    expect(shortcuts.getShortcut("nonexistent")).toBe("");
  });

  it("setShortcut persists override and getShortcut reflects it", () => {
    shortcuts.setShortcut("toggle-pane-focus", "Alt+Left");
    expect(shortcuts.getShortcut("toggle-pane-focus")).toBe("Alt+Left");

    // Reload and verify persistence
    const fresh = loadModule();
    fresh.loadShortcuts();
    expect(fresh.getShortcut("toggle-pane-focus")).toBe("Alt+Left");
  });

  it("setShortcut to default value removes override", () => {
    shortcuts.setShortcut("new-session", "CmdOrCtrl+Shift+N");
    expect(shortcuts.getShortcut("new-session")).toBe("CmdOrCtrl+Shift+N");

    shortcuts.setShortcut("new-session", "CmdOrCtrl+N"); // back to default
    const shortcutsFile = env.resolve("shortcuts.json");
    const data = JSON.parse(fs.readFileSync(shortcutsFile, "utf-8"));
    expect(data["new-session"]).toBeUndefined();
  });

  it("resetShortcut removes override", () => {
    shortcuts.setShortcut("focus-editor", "CmdOrCtrl+Shift+E");
    expect(shortcuts.getShortcut("focus-editor")).toBe("CmdOrCtrl+Shift+E");

    shortcuts.resetShortcut("focus-editor");
    expect(shortcuts.getShortcut("focus-editor")).toBe("CmdOrCtrl+E");
  });

  it("getDefaultShortcut always returns the built-in default", () => {
    shortcuts.setShortcut("new-session", "F12");
    expect(shortcuts.getDefaultShortcut("new-session")).toBe("CmdOrCtrl+N");
  });

  it("toggle-pane-focus defaults to unbound", () => {
    expect(shortcuts.getShortcut("toggle-pane-focus")).toBe("");
  });

  it("cycle-pane defaults to CmdOrCtrl+Shift+Tab", () => {
    expect(shortcuts.getShortcut("cycle-pane")).toBe("CmdOrCtrl+Shift+Tab");
  });
});

describe("matchesInput", () => {
  let env2;
  let mod;

  beforeEach(() => {
    env2 = createTestEnv();
    mod = loadModule();
  });

  afterEach(() => {
    env2.cleanup();
  });

  it("matches Ctrl+Tab", () => {
    const input = {
      key: "Tab",
      meta: false,
      control: true,
      shift: false,
      alt: false,
    };
    expect(mod.matchesInput(input, "Ctrl+Tab")).toBe(true);
    expect(mod.matchesInput(input, "Ctrl+Shift+Tab")).toBe(false);
  });

  it("matches CmdOrCtrl+Shift+Tab on macOS (meta)", () => {
    const input = {
      key: "Tab",
      meta: true,
      control: false,
      shift: true,
      alt: false,
    };
    expect(mod.matchesInput(input, "CmdOrCtrl+Shift+Tab")).toBe(true);
  });

  it("matches Alt+Down", () => {
    const input = {
      key: "ArrowDown",
      meta: false,
      control: false,
      shift: false,
      alt: true,
    };
    expect(mod.matchesInput(input, "Alt+Down")).toBe(true);
    expect(mod.matchesInput(input, "Alt+Up")).toBe(false);
  });

  it("returns false for empty accelerator", () => {
    const input = {
      key: "Tab",
      meta: false,
      control: true,
      shift: false,
      alt: false,
    };
    expect(mod.matchesInput(input, "")).toBe(false);
  });

  it("matches CmdOrCtrl+E (meta on macOS)", () => {
    const input = {
      key: "e",
      meta: true,
      control: false,
      shift: false,
      alt: false,
    };
    expect(mod.matchesInput(input, "CmdOrCtrl+E")).toBe(true);
  });
});

describe("findMatchingInputAction", () => {
  let env3;

  beforeEach(() => {
    env3 = createTestEnv();
  });

  afterEach(() => {
    env3.cleanup();
  });

  it("finds matching action from cached accelerators", () => {
    const mod = loadModule();
    mod.loadShortcuts();

    const input = {
      key: "ArrowDown",
      meta: false,
      control: false,
      shift: false,
      alt: true,
    };
    expect(mod.findMatchingInputAction(input)).toBe("next-session");
  });

  it("returns null when no action matches", () => {
    const mod = loadModule();
    mod.loadShortcuts();

    const input = {
      key: "z",
      meta: false,
      control: false,
      shift: false,
      alt: false,
    };
    expect(mod.findMatchingInputAction(input)).toBeNull();
  });
});
