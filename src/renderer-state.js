// Shared mutable state for renderer modules.
// All renderer modules import from here instead of passing state through params.

import { STATUS, POOL_STATUS } from "./session-statuses.js";

// --- Status CSS classes (shared across sidebar and pool UI) ---
export const STATUS_CLASSES = {
  [STATUS.IDLE]: "idle",
  [STATUS.PROCESSING]: "processing",
  [STATUS.FRESH]: "fresh",
  [STATUS.TYPING]: "typing",
  [STATUS.DEAD]: "dead",
  [STATUS.OFFLOADED]: "offloaded",
  [STATUS.ARCHIVED]: "archived",
};

// --- Shared utilities ---
export function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Debug logging ---
export function debugLog(tag, ...args) {
  window.api?.debugLog?.(`renderer:${tag}`, ...args);
}

// --- DOM refs (populated in renderer.js init) ---
export const dom = {
  sessionList: null,
  refreshBtn: null,
  newSessionBtn: null,
  emptyState: null,
  sessionView: null,
  dockContainer: null,
  sidebar: null,
  commandPalette: null,
  commandPaletteInput: null,
  commandPaletteList: null,
};

// --- Mutable state ---
export const state = {
  dock: null,
  editorContainer: null,
  editorMount: null,
  editorProject: null,
  saveStatus: null,
  shellCounter: 0,
  cachedSessions: [],
  sidebarSessions: [], // section-ordered top-level sessions (matches sidebar DOM)
  currentSessionId: null,
  currentSessionCwd: null,
  saveTimeout: null,
  editorView: null,
  sessionGeneration: 0,
  previousSessionId: null,
  terminals: [], // active view into current session's terminals
};

// Session terminal cache: Map<sessionId, { terminals: [], lastAccessed: number }>
export const sessionTerminals = new Map();
export const CLEANUP_AFTER_MS = 30 * 60 * 1000; // 30 minutes

// --- Bell mute toggle (persisted via localStorage) ---
let _bellMuted = localStorage.getItem("bellMuted") === "true";

export function isBellMuted() {
  return _bellMuted;
}

export function toggleBellMuted() {
  _bellMuted = !_bellMuted;
  localStorage.setItem("bellMuted", _bellMuted);
  syncBellButton();
}

export function syncBellButton() {
  const btn = document.getElementById("bell-toggle-btn");
  if (!btn) return;
  btn.textContent = _bellMuted ? "\uD83D\uDD15" : "\uD83D\uDD14";
  btn.title = _bellMuted
    ? "Bell muted (click to unmute)"
    : "Bell enabled (click to mute)";
}

// --- User activity tracking (for bell suppression) ---
let lastActivityTs = Date.now();

export function trackActivity() {
  lastActivityTs = Date.now();
}

export function isUserActive(thresholdMs = 20_000) {
  return Date.now() - lastActivityTs <= thresholdMs;
}

for (const evt of ["pointerdown", "keydown", "wheel", "scroll"]) {
  document.addEventListener(evt, trackActivity, {
    passive: true,
    capture: true,
  });
}

// --- Notification helpers ---

export function showNotification(msg) {
  if (!state.saveStatus) return;
  state.saveStatus.textContent = msg;
  setTimeout(() => {
    if (state.saveStatus && state.saveStatus.textContent === msg)
      state.saveStatus.textContent = "";
  }, 3000);
}

export function showToast(msg, level = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.textContent = msg;
  container.appendChild(toast);
  function dismiss() {
    toast.classList.add("toast-exit");
    toast.addEventListener("animationend", () => toast.remove(), {
      once: true,
    });
    setTimeout(() => toast.remove(), 300);
  }
  const autoId = setTimeout(dismiss, 8000);
  toast.addEventListener("click", () => {
    clearTimeout(autoId);
    dismiss();
  });
}
