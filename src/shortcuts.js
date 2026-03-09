// Shortcut configuration system
// Stores user overrides in ~/.open-cockpit/shortcuts.json
// Missing keys use defaults from DEFAULT_SHORTCUTS

const fs = require("fs");
const path = require("path");
const os = require("os");
const { secureMkdirSync, secureWriteFileSync } = require("./secure-fs");

const SHORTCUTS_FILE = path.join(
  os.homedir(),
  ".open-cockpit",
  "shortcuts.json",
);

// Default shortcut mappings: action ID -> Electron accelerator string
// Empty string = unbound by default
const DEFAULT_SHORTCUTS = {
  "new-session": "CmdOrCtrl+N",
  "new-terminal-tab": "CmdOrCtrl+T",
  "close-terminal-tab": "CmdOrCtrl+W",
  "next-tab": "CmdOrCtrl+Shift+]",
  "prev-tab": "CmdOrCtrl+Shift+[",
  "next-session": "Alt+Down",
  "prev-session": "Alt+Up",
  "toggle-sidebar": "CmdOrCtrl+\\",
  "toggle-pane-focus": "",
  "cycle-pane": "CmdOrCtrl+Shift+Tab",
  "focus-editor": "CmdOrCtrl+E",
  "focus-terminal": "CmdOrCtrl+`",
  "focus-external": "CmdOrCtrl+O",
  "jump-recent-idle": "CmdOrCtrl+J",
  "archive-current-session": "CmdOrCtrl+D",
  "open-in-cursor": "Ctrl+Alt+Cmd+C",
  "toggle-command-palette": "CmdOrCtrl+/",
  "open-pool-settings": "CmdOrCtrl+,",
  // Dock panel management
  "focus-next-pane": "CmdOrCtrl+Alt+]",
  "focus-prev-pane": "CmdOrCtrl+Alt+[",
  "split-right": "",
  "split-down": "",
  // Child session navigation
  "toggle-children": "Alt+Shift+Right",
  "next-child-session": "Alt+Shift+Down",
  "prev-child-session": "Alt+Shift+Up",
  // Custom session
  "new-custom-session": "CmdOrCtrl+Shift+N",
  // Bell
  "toggle-bell": "CmdOrCtrl+Shift+B",
  // Session actions
  "resume-session": "",
  // Session search
  "session-search": "CmdOrCtrl+K",
  // Session info
  "session-info": "CmdOrCtrl+I",
  // These are handled via before-input-event, not menu accelerators
  "next-terminal-tab-alt": "Ctrl+Tab",
  "prev-terminal-tab-alt": "Ctrl+Shift+Tab",
};

// Actions that use before-input-event instead of menu accelerators
const INPUT_EVENT_ACTIONS = new Set([
  "next-terminal-tab-alt",
  "prev-terminal-tab-alt",
  "next-session",
  "prev-session",
  "cycle-pane",
  "focus-next-pane",
  "focus-prev-pane",
  "toggle-children",
  "next-child-session",
  "prev-child-session",
]);

let userOverrides = {};

// Pre-parsed accelerators for input-event actions (avoids re-parsing on every keypress)
const parsedInputAccels = new Map(); // actionId -> { parsed, channel }

function rebuildParsedCache() {
  parsedInputAccels.clear();
  for (const actionId of INPUT_EVENT_ACTIONS) {
    const accel = getShortcut(actionId);
    if (accel) {
      const parsed = parseAccelerator(accel);
      if (parsed) parsedInputAccels.set(actionId, parsed);
    }
  }
}

function loadShortcuts() {
  try {
    const data = fs.readFileSync(SHORTCUTS_FILE, "utf-8");
    userOverrides = JSON.parse(data);
  } catch {
    userOverrides = {};
  }
  rebuildParsedCache();
}

function saveShortcuts() {
  try {
    secureMkdirSync(path.dirname(SHORTCUTS_FILE), { recursive: true });
    secureWriteFileSync(SHORTCUTS_FILE, JSON.stringify(userOverrides, null, 2));
  } catch (err) {
    console.error("[shortcuts] Failed to save:", err.message);
  }
}

function getShortcut(actionId) {
  if (actionId in userOverrides) return userOverrides[actionId];
  return DEFAULT_SHORTCUTS[actionId] || "";
}

function getAllShortcuts() {
  const result = {};
  for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
    result[id] = getShortcut(id);
  }
  return result;
}

function getDefaultShortcut(actionId) {
  return DEFAULT_SHORTCUTS[actionId] || "";
}

function setShortcut(actionId, accelerator) {
  if (accelerator === DEFAULT_SHORTCUTS[actionId]) {
    delete userOverrides[actionId];
  } else {
    userOverrides[actionId] = accelerator;
  }
  saveShortcuts();
  rebuildParsedCache();
}

function resetShortcut(actionId) {
  delete userOverrides[actionId];
  saveShortcuts();
  rebuildParsedCache();
}

// Parse an Electron accelerator into a before-input-event matcher
// Returns null if the accelerator can't be matched via input events
function parseAccelerator(accel) {
  if (!accel) return null;
  const parts = accel.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  return {
    meta: mods.has("cmd") || mods.has("cmdorctrl") || mods.has("command"),
    control: mods.has("ctrl") || mods.has("cmdorctrl") || mods.has("control"),
    shift: mods.has("shift"),
    alt: mods.has("alt") || mods.has("option"),
    key,
  };
}

// Key normalization map (shared between matchesInput and matchesParsed)
const INPUT_KEY_MAP = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

// Map from KeyboardEvent.code to Electron accelerator key name.
// On macOS, Option mangles key values (e.g. Option+] → '), so we fall back
// to code when the key doesn't match (only for non-letter/non-arrow keys).
const CODE_TO_KEY = {
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  comma: ",",
  period: ".",
  slash: "/",
  minus: "-",
  equal: "=",
  backquote: "`",
};

function matchesParsed(input, parsed) {
  let inputKey =
    INPUT_KEY_MAP[input.key.toLowerCase()] || input.key.toLowerCase();

  // Fall back to code-based key when Alt mangles the key value
  if (inputKey !== parsed.key && input.code) {
    const codeKey = CODE_TO_KEY[input.code.toLowerCase()];
    if (codeKey) inputKey = codeKey;
  }

  if (inputKey !== parsed.key) return false;

  const wantsMeta = parsed.meta;
  const wantsCtrl = parsed.control && !parsed.meta;
  if (wantsMeta && !input.meta) return false;
  if (wantsCtrl && !input.control) return false;
  if (parsed.shift !== input.shift) return false;
  if (parsed.alt !== input.alt) return false;
  return true;
}

// Check if a before-input-event input matches an accelerator string
function matchesInput(input, accel) {
  const parsed = parseAccelerator(accel);
  if (!parsed) return false;
  return matchesParsed(input, parsed);
}

// Find matching input-event action using pre-parsed cache (hot path)
// Returns actionId or null
function findMatchingInputAction(input) {
  for (const [actionId, parsed] of parsedInputAccels) {
    if (matchesParsed(input, parsed)) return actionId;
  }
  return null;
}

module.exports = {
  DEFAULT_SHORTCUTS,
  INPUT_EVENT_ACTIONS,
  loadShortcuts,
  getShortcut,
  getAllShortcuts,
  getDefaultShortcut,
  setShortcut,
  resetShortcut,
  matchesInput,
  findMatchingInputAction,
};
