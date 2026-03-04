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

  it("registers session navigation accelerators", () => {
    expect(mainSource).toContain('accelerator: "Alt+Down"');
    expect(mainSource).toContain('accelerator: "Alt+Up"');
  });

  it("registers sidebar toggle accelerator", () => {
    expect(mainSource).toContain('accelerator: "CmdOrCtrl+\\\\"');
  });

  it("registers focus accelerators", () => {
    expect(mainSource).toContain('accelerator: "CmdOrCtrl+E"');
    expect(mainSource).toContain('accelerator: "CmdOrCtrl+`"');
  });

  it("registers command palette accelerator", () => {
    expect(mainSource).toContain('accelerator: "CmdOrCtrl+/"');
  });

  it("registers new session accelerator", () => {
    expect(mainSource).toContain('accelerator: "CmdOrCtrl+N"');
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
    ];
    for (const msg of ipcMessages) {
      expect(mainSource, `Missing IPC send for "${msg}"`).toContain(`"${msg}"`);
    }
  });

  it("handles Alt+Up/Down in before-input-event", () => {
    expect(mainSource).toContain("ArrowUp");
    expect(mainSource).toContain("ArrowDown");
    expect(mainSource).toContain("input.alt");
  });

  it("handles Escape for focus-terminal", () => {
    expect(mainSource).toContain('input.key === "Escape"');
    expect(mainSource).toContain("focus-terminal");
  });
});
