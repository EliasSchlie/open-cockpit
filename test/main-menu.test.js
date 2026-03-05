import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Parse main.js source to verify menu structure
const mainSource = fs.readFileSync(
  path.join(__dirname, "../src/main.js"),
  "utf-8",
);

describe("Main process menu", () => {
  it("has a Navigate menu", () => {
    expect(mainSource).toContain('label: "Navigate"');
  });

  it("uses dynamic accelerators from shortcuts config", () => {
    // Menu accelerators are now dynamic via accel() helper
    expect(mainSource).toContain("accel(");
    expect(mainSource).toContain('accel("new-session")');
    expect(mainSource).toContain('accel("toggle-sidebar")');
    expect(mainSource).toContain('accel("focus-editor")');
    expect(mainSource).toContain('accel("focus-terminal")');
    expect(mainSource).toContain('accel("toggle-command-palette")');
  });

  it("sends correct IPC messages for navigation", () => {
    const ipcMessages = [
      "next-session",
      "prev-session",
      "toggle-sidebar",
      "focus-editor",
      "focus-terminal",
      "toggle-command-palette",
      "new-session",
      "cycle-pane",
    ];
    for (const msg of ipcMessages) {
      expect(mainSource, `Missing IPC send for "${msg}"`).toContain(`"${msg}"`);
    }
  });

  it("handles input-event-based shortcuts via cached matching", () => {
    expect(mainSource).toContain("findMatchingInputAction");
    expect(mainSource).toContain("INPUT_EVENT_ACTIONS");
    expect(mainSource).toContain("before-input-event");
  });

  it("handles Escape for focus-terminal", () => {
    expect(mainSource).toContain('input.key === "Escape"');
    expect(mainSource).toContain("focus-terminal");
  });

  it("supports menu rebuild on shortcut change", () => {
    expect(mainSource).toContain("buildMenu()");
    expect(mainSource).toContain('ipcMain.handle("set-shortcut"');
    expect(mainSource).toContain('ipcMain.handle("reset-shortcut"');
  });
});
