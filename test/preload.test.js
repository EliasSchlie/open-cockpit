import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Verify the preload.js exposes all required IPC channels
// We parse the source since we can't require it outside Electron

const preloadSource = fs.readFileSync(
  path.join(__dirname, "../src/preload.js"),
  "utf-8",
);

describe("Preload channel registration", () => {
  // Extract channel names from the removeAllListeners cleanup array
  const channelArrayMatch = preloadSource.match(
    /const channels = \[([\s\S]*?)\];/,
  );
  const cleanupChannels = channelArrayMatch
    ? channelArrayMatch[1].match(/"([^"]+)"/g).map((s) => s.replace(/"/g, ""))
    : [];

  // Extract all ipcRenderer.on("channel-name", ...) registrations
  const onChannels = [
    ...preloadSource.matchAll(/ipcRenderer\.on\("([^"]+)"/g),
  ].map((m) => m[1]);

  it("cleans up all channels that are registered as listeners", () => {
    for (const ch of onChannels) {
      expect(
        cleanupChannels,
        `Channel "${ch}" is registered but not cleaned up`,
      ).toContain(ch);
    }
  });

  it("has navigation channels registered", () => {
    const navigationChannels = [
      "next-session",
      "prev-session",
      "new-session",
      "toggle-sidebar",
      "focus-editor",
      "focus-terminal",
      "toggle-command-palette",
    ];
    for (const ch of navigationChannels) {
      expect(cleanupChannels, `Missing cleanup for ${ch}`).toContain(ch);
      expect(onChannels, `Missing listener for ${ch}`).toContain(ch);
    }
  });

  it("has terminal tab channels registered", () => {
    const termChannels = [
      "new-terminal-tab",
      "close-terminal-tab",
      "next-terminal-tab",
      "prev-terminal-tab",
      "switch-terminal-tab",
    ];
    for (const ch of termChannels) {
      expect(cleanupChannels).toContain(ch);
      expect(onChannels).toContain(ch);
    }
  });

  it("exposes API methods for navigation", () => {
    const expectedMethods = [
      "onNewSession",
      "onNextSession",
      "onPrevSession",
      "onToggleSidebar",
      "onFocusEditor",
      "onFocusTerminal",
      "onToggleCommandPalette",
    ];
    for (const method of expectedMethods) {
      expect(preloadSource, `Missing API method: ${method}`).toContain(method);
    }
  });
});
