import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Read source files for static analysis
const srcDir = path.join(__dirname, "../src");
const read = (file) => fs.readFileSync(path.join(srcDir, file), "utf-8");

const mainSource = read("main.js");
const preloadSource = read("preload.js");
const commandPaletteSource = read("command-palette.js");
const shortcutsSource = read("shortcuts.js");

// Extract action IDs from DEFAULT_SHORTCUTS
const defaultShortcutsMatch = shortcutsSource.match(
  /const DEFAULT_SHORTCUTS = \{([\s\S]*?)\n\};/,
);
const shortcutActionIds = [
  ...defaultShortcutsMatch[1].matchAll(/"([^"]+)":/g),
].map((m) => m[1]);

// Extract INPUT_EVENT_ACTIONS
const inputEventMatch = shortcutsSource.match(
  /const INPUT_EVENT_ACTIONS = new Set\(\[([\s\S]*?)\]\)/,
);
const inputEventActions = new Set(
  [...inputEventMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
);

// Actions that are menu-accelerator-driven (not input-event-only)
const menuActions = shortcutActionIds.filter(
  (id) => !inputEventActions.has(id),
);

// Actions that legitimately don't need a menu item because they're only
// reachable via input events or have special handling
const MENU_EXEMPT = new Set([]);

// Actions handled entirely in the main process (no renderer IPC channel needed)
const MAIN_PROCESS_ONLY = new Set(["relaunch-app", "restart-daemon"]);

// Shortcut action IDs that map to a different IPC channel name
// (e.g. "next-tab" shortcut sends "next-terminal-tab" IPC message)
const CHANNEL_ALIASES = {
  "next-tab": "next-terminal-tab",
  "prev-tab": "prev-terminal-tab",
};

// Actions that don't need a command palette entry (internal/structural)
const PALETTE_EXEMPT = new Set([
  // toggle-command-palette opens the palette itself — it's not a palette command
  "toggle-command-palette",
]);

describe("Shortcut completeness", () => {
  it("every menu-driven shortcut has a menu item in main.js", () => {
    const missing = menuActions
      .filter((id) => !MENU_EXEMPT.has(id))
      .filter((id) => !mainSource.includes(`accel("${id}")`));

    expect(
      missing,
      `Missing menu items in main.js: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every shortcut action has its channel in preload.js channels array", () => {
    // Extract the channels array content
    const channelsMatch = preloadSource.match(
      /const channels = \[([\s\S]*?)\];/,
    );
    const channelsList = [...channelsMatch[1].matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    const channelsSet = new Set(channelsList);

    // Every action from DEFAULT_SHORTCUTS should have a channel
    // (input-event actions still send IPC messages for the renderer)
    // Check both the action ID and any alias
    const missing = shortcutActionIds.filter(
      (id) =>
        !MAIN_PROCESS_ONLY.has(id) &&
        !channelsSet.has(CHANNEL_ALIASES[id] || id),
    );

    // -alt variants don't have their own channels (they map to existing ones)
    const missingNonAlt = missing.filter((id) => !id.endsWith("-alt"));

    expect(
      missingNonAlt,
      `Missing channels in preload.js: ${missingNonAlt.join(", ")}`,
    ).toEqual([]);
  });

  it("every shortcut action has an IPC listener (on*) in preload.js", () => {
    // Extract all ipcRenderer.on("channel-name", ...) registrations
    const listeners = [
      ...preloadSource.matchAll(/ipcRenderer\.on\("([^"]+)"/g),
    ].map((m) => m[1]);
    const listenerSet = new Set(listeners);

    const missing = shortcutActionIds
      .filter((id) => !id.endsWith("-alt"))
      .filter((id) => !MAIN_PROCESS_ONLY.has(id))
      .filter((id) => !listenerSet.has(CHANNEL_ALIASES[id] || id));

    expect(
      missing,
      `Missing IPC listeners in preload.js: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every menu-driven shortcut has a command palette entry", () => {
    // Extract shortcutAction values from command-palette.js
    const paletteActions = [
      ...commandPaletteSource.matchAll(/shortcutAction:\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    const paletteSet = new Set(paletteActions);

    const missing = menuActions
      .filter((id) => !PALETTE_EXEMPT.has(id))
      .filter((id) => !paletteSet.has(id));

    expect(
      missing,
      `Missing command palette entries: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no orphaned palette entries without a shortcut definition", () => {
    const paletteActions = [
      ...commandPaletteSource.matchAll(/shortcutAction:\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    const shortcutSet = new Set(shortcutActionIds);

    const orphaned = paletteActions.filter((id) => !shortcutSet.has(id));

    expect(
      orphaned,
      `Orphaned palette entries (no shortcut): ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("no orphaned menu items without a shortcut definition", () => {
    // Extract accel("action-id") calls from main.js
    const menuAccels = [...mainSource.matchAll(/accel\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    const shortcutSet = new Set(shortcutActionIds);

    const orphaned = menuAccels.filter((id) => !shortcutSet.has(id));

    expect(
      orphaned,
      `Orphaned menu accel() calls (no shortcut): ${orphaned.join(", ")}`,
    ).toEqual([]);
  });
});
