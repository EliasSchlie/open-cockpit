import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  Decoration,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

// --- Debug logging (writes to ~/.open-cockpit/debug.log via main process) ---
function debugLog(tag, ...args) {
  window.api?.debugLog?.(`renderer:${tag}`, ...args);
}

// --- Bullet widget: replaces "- " / "* " / "1. " with rendered bullet ---
class BulletWidget extends WidgetType {
  constructor(ordered, index) {
    super();
    this.ordered = ordered;
    this.index = index;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-bullet-char";
    span.textContent = this.ordered ? `${this.index}.  ` : "•  ";
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

// --- Live preview theme ---
const livePreviewTheme = EditorView.theme({
  "&": {
    fontSize: "14px",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  },
  ".cm-content": {
    padding: "16px 24px",
    maxWidth: "800px",
    lineHeight: "1.7",
  },
  ".cm-line": {
    padding: "1px 0",
  },
  ".cm-md-heading1": {
    fontSize: "1.8em",
    fontWeight: "700",
    color: "#ff1a1a",
    marginTop: "8px",
  },
  ".cm-md-heading2": {
    fontSize: "1.4em",
    fontWeight: "600",
    color: "#ff4444",
    marginTop: "6px",
  },
  ".cm-md-heading3": {
    fontSize: "1.2em",
    fontWeight: "600",
    color: "#ff6666",
    marginTop: "4px",
  },
  ".cm-md-bold": { fontWeight: "700" },
  ".cm-md-italic": { fontStyle: "italic" },
  ".cm-md-code": {
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: "13px",
    background: "#252525",
    padding: "1px 5px",
    borderRadius: "3px",
    color: "#ff6666",
  },
  ".cm-md-link": { color: "#ff4444", textDecoration: "underline" },
  ".cm-md-strikethrough": { textDecoration: "line-through", color: "#808080" },
  ".cm-md-bullet-char": {
    color: "#ff1a1a",
    fontWeight: "600",
    marginRight: "2px",
  },
  ".cm-md-list-line": { paddingLeft: "8px" },
  ".cm-md-blockquote": {
    borderLeft: "3px solid #ff1a1a",
    paddingLeft: "14px",
    color: "#999999",
  },
  ".cm-md-hr": {
    display: "block",
    borderTop: "1px solid #252525",
    margin: "12px 0",
  },
  ".cm-md-checkbox": { marginRight: "4px" },
});

const INLINE_STYLES = {
  StrongEmphasis: "cm-md-bold",
  Emphasis: "cm-md-italic",
  InlineCode: "cm-md-code",
  Strikethrough: "cm-md-strikethrough",
};

const SYNTAX_MARKS = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "QuoteMark",
]);

function getActiveLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let i = startLine; i <= endLine; i++) {
      lines.add(i);
    }
  }
  return lines;
}

function buildDecorations(view) {
  const { state } = view;
  const activeLines = getActiveLines(state);
  const decorations = [];
  const tree = syntaxTree(state);
  const processedLines = new Set();
  let orderedIndex = 0;
  let linkDepth = 0;
  const isLinkContainer = (n) => n === "Link" || n === "Image";

  tree.iterate({
    leave(node) {
      if (isLinkContainer(node.name)) linkDepth--;
    },
    enter(node) {
      if (isLinkContainer(node.name)) linkDepth++;
      const line = state.doc.lineAt(node.from);
      const isActive = activeLines.has(line.number);

      if (node.name.startsWith("ATXHeading") && !node.name.includes("Mark")) {
        const level = node.name.match(/(\d)$/)?.[1] || "1";
        if (!processedLines.has(`heading-${line.number}`)) {
          decorations.push(
            Decoration.line({ class: `cm-md-heading${level}` }).range(
              line.from,
            ),
          );
          processedLines.add(`heading-${line.number}`);
        }
        if (isActive) return;
      }

      if (isActive) return;

      if (node.name === "Blockquote") {
        const startLine = state.doc.lineAt(node.from).number;
        const endLine = state.doc.lineAt(node.to).number;
        for (let i = startLine; i <= endLine; i++) {
          if (!activeLines.has(i) && !processedLines.has(`bq-${i}`)) {
            decorations.push(
              Decoration.line({ class: "cm-md-blockquote" }).range(
                state.doc.line(i).from,
              ),
            );
            processedLines.add(`bq-${i}`);
          }
        }
      }

      if (node.name === "ListMark") {
        const text = state.doc.sliceString(node.from, node.to);
        const isOrdered = /^\d+[.)]$/.test(text);
        if (isOrdered) {
          orderedIndex++;
        } else {
          orderedIndex = 0;
        }
        let end = node.to;
        if (
          end < state.doc.length &&
          state.doc.sliceString(end, end + 1) === " "
        ) {
          end += 1;
        }
        decorations.push(
          Decoration.replace({
            widget: new BulletWidget(isOrdered, orderedIndex),
          }).range(node.from, end),
        );
        if (!processedLines.has(`list-${line.number}`)) {
          decorations.push(
            Decoration.line({ class: "cm-md-list-line" }).range(line.from),
          );
          processedLines.add(`list-${line.number}`);
        }
        return;
      }

      if (SYNTAX_MARKS.has(node.name) && node.from < node.to) {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }
      if (node.name === "LinkMark" && node.from < node.to) {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }
      // Only hide URL nodes inside Link/Image (e.g. [text](url)), not standalone bare URLs
      if (node.name === "URL" && node.from < node.to && linkDepth > 0) {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }

      const styleClass = INLINE_STYLES[node.name];
      if (styleClass && node.from < node.to) {
        decorations.push(
          Decoration.mark({ class: styleClass }).range(node.from, node.to),
        );
      }
      if (
        (node.name === "Link" ||
          node.name === "Autolink" ||
          (node.name === "URL" && linkDepth === 0)) &&
        node.from < node.to
      ) {
        decorations.push(
          Decoration.mark({ class: "cm-md-link" }).range(node.from, node.to),
        );
      }
      if (node.name === "HorizontalRule") {
        decorations.push(
          Decoration.line({ class: "cm-md-hr" }).range(line.from),
        );
      }
    },
  });

  decorations.sort((a, b) => a.from - b.from || a.startSide - b.startSide);
  return Decoration.set(decorations, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const darkTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#0a0a0a",
      color: "#e0e0e0",
      height: "100%",
    },
    ".cm-cursor": { borderLeftColor: "#c0c0c0" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#2a0808",
    },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine": { backgroundColor: "#121212" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { overflow: "auto" },
  },
  { dark: true },
);

// --- xterm.js theme (minimal — let shell theme handle ANSI colors) ---
const TERM_THEME = {
  background: "#0a0a0a",
};

function createTerminal(extraOpts = {}) {
  return new Terminal({
    theme: TERM_THEME,
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: false,
    ...extraOpts,
  });
}

// --- Directory color coding ---
// Neon-friendly palette for directory indicators
const DIR_COLORS = [
  "#ff1a1a", // neon red
  "#00ff41", // neon green
  "#ff6600", // neon orange
  "#00ccff", // neon cyan
  "#ff00ff", // neon magenta
  "#ffff00", // neon yellow
  "#7b68ee", // neon purple
  "#ff69b4", // neon pink
  "#00ff88", // neon mint
  "#ff4500", // neon vermillion
];

// User-configured colors from ~/.open-cockpit/colors.json
// Format: { "~/Documents/Projects/foo": "#ff00ff" }
// null value = no color (transparent)
let userDirColors = {};

async function loadDirColors() {
  userDirColors = await window.api.getDirColors();
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Get the path used for color hashing.
// - Worktrees (.claude/worktrees/xxx) → parent project dir
// - Inside a git repo → git root
// - Otherwise → exact cwd (each folder gets its own color)
function getColorKey(session) {
  const { cwd, gitRoot, home } = session;
  if (!cwd) return "";
  // Strip worktree suffix (.claude/worktrees/xxx or .wt/xxx)
  const wtMatch = cwd.match(/^(.+?)\/(?:\.claude\/worktrees|\.wt)\/.+$/);
  const resolved = wtMatch ? wtMatch[1] : cwd;
  // If inside a git repo, use the git root
  if (gitRoot) {
    // Also handle worktree: if the worktree-stripped path has a git root,
    // use the worktree-stripped path (it IS the git root)
    if (wtMatch) return wtMatch[1];
    return gitRoot;
  }
  return resolved;
}

function getDirColor(session) {
  const { cwd, home } = session;
  if (!cwd) return null;
  // Home directory exactly → no color
  if (cwd === home) return null;

  const colorKey = getColorKey(session);

  // Check user config — match longest prefix first
  const configKeys = Object.keys(userDirColors).sort(
    (a, b) => b.length - a.length,
  );
  for (const key of configKeys) {
    const expandedKey = home ? key.replace(/^~/, home) : key;
    if (colorKey === expandedKey || colorKey.startsWith(expandedKey + "/")) {
      return userDirColors[key]; // null = no color, string = exact color
    }
  }

  return DIR_COLORS[hashString(colorKey) % DIR_COLORS.length];
}

// --- App logic ---
const sessionList = document.getElementById("session-list");
const refreshBtn = document.getElementById("refresh-btn");
const newSessionBtn = document.getElementById("new-session-btn");
const emptyState = document.getElementById("empty-state");
const sessionView = document.getElementById("session-view");
const editorPane = document.getElementById("editor-pane");
const editorProject = document.getElementById("editor-project");
const saveStatus = document.getElementById("save-status");
const editorMount = document.getElementById("editor-mount");
const terminalTabList = document.getElementById("terminal-tab-list");
const newTermBtn = document.getElementById("new-term-btn");
const terminalMount = document.getElementById("terminal-mount");
const sidebar = document.getElementById("sidebar");
const commandPalette = document.getElementById("command-palette");
const commandPaletteInput = document.getElementById("command-palette-input");
const commandPaletteList = document.getElementById("command-palette-list");

// Keep a cached copy of sessions for keyboard navigation
let cachedSessions = [];

let currentSessionId = null;
let currentSessionCwd = null;
let saveTimeout = null;
let editorView = null;

// Terminal state: per-session cache for persistent terminals
// Map<sessionId, { terminals: [], activeTermIndex: number, lastAccessed: number }>
const sessionTerminals = new Map();
const CLEANUP_AFTER_MS = 30 * 60 * 1000; // 30 minutes

// Active view into current session's terminals
let terminals = [];
let activeTermIndex = -1;
// Generation counter to detect stale async operations after session switches
let sessionGeneration = 0;

// Sync current terminals into the session cache (renderer + main process)
function syncSessionCache() {
  if (!currentSessionId) return;
  if (terminals.length === 0) {
    sessionTerminals.delete(currentSessionId);
  } else {
    sessionTerminals.set(currentSessionId, {
      terminals: [...terminals],
      activeTermIndex,
      lastAccessed: Date.now(),
    });
    // Keep main process metadata in sync
    for (const t of terminals) {
      window.api.ptySetSession(t.termId, currentSessionId);
    }
  }
}

function createEditor(content) {
  if (editorView) editorView.destroy();

  const state = EditorState.create({
    doc: content,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ base: markdownLanguage }),
      livePreviewPlugin,
      livePreviewTheme,
      darkTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleSave();
      }),
    ],
  });

  editorView = new EditorView({ state, parent: editorMount });
}

async function spawnTerminal(cwd, cmd, args) {
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;display:none;";
  terminalMount.appendChild(container);

  const term = createTerminal();

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  let termId, pid;
  try {
    ({ termId, pid } = await window.api.ptySpawn({
      cwd: cwd || undefined,
      cmd: cmd || undefined,
      args: args || undefined,
      sessionId: currentSessionId || undefined,
    }));
  } catch (err) {
    term.dispose();
    container.remove();
    throw err;
  }

  const entry = {
    termId,
    pid,
    term,
    fitAddon,
    resizeObserver: null,
    container,
    isPoolTui: false,
  };
  terminals.push(entry);

  // Register before attach so replay/data can find this terminal
  pendingTerminals.set(termId, entry);
  try {
    await window.api.ptyAttach(termId);
  } catch (err) {
    debugLog("term", `attach failed termId=${termId}`, err.message);
    const idx = terminals.indexOf(entry);
    if (idx !== -1) terminals.splice(idx, 1);
    term.dispose();
    container.remove();
    pendingTerminals.delete(termId);
    throw err;
  }
  pendingTerminals.delete(termId);

  term.onData((data) => window.api.ptyWrite(termId, data));

  const resizeObserver = new ResizeObserver(() => {
    if (container.style.display !== "none") {
      fitAddon.fit();
      window.api.ptyResize(termId, term.cols, term.rows);
    }
  });
  resizeObserver.observe(terminalMount);
  entry.resizeObserver = resizeObserver;

  renderTerminalTabs();
  switchToTerminal(terminals.length - 1);
  syncSessionCache();

  return entry;
}

// Attach to an existing pool slot's PTY (no spawn — the Claude TUI is already running)
async function attachPoolTerminal(poolTermId) {
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;display:none;";
  terminalMount.appendChild(container);

  const term = createTerminal();

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const entry = {
    termId: poolTermId,
    pid: null,
    term,
    fitAddon,
    resizeObserver: null,
    container,
    isPoolTui: true,
  };
  terminals.push(entry);

  // Register before attach so replay/data can find this terminal
  pendingTerminals.set(poolTermId, entry);
  try {
    await window.api.ptyAttach(poolTermId);
  } catch (err) {
    debugLog("pool", `attach failed poolTermId=${poolTermId}`, err.message);
    const idx = terminals.indexOf(entry);
    if (idx !== -1) terminals.splice(idx, 1);
    term.dispose();
    container.remove();
    pendingTerminals.delete(poolTermId);
    throw err;
  }
  pendingTerminals.delete(poolTermId);

  term.onData((data) => window.api.ptyWrite(poolTermId, data));

  const resizeObserver = new ResizeObserver(() => {
    if (container.style.display !== "none") {
      fitAddon.fit();
      window.api.ptyResize(poolTermId, term.cols, term.rows);
    }
  });
  resizeObserver.observe(terminalMount);
  entry.resizeObserver = resizeObserver;

  renderTerminalTabs();
  switchToTerminal(terminals.length - 1);
  syncSessionCache();

  return entry;
}

function switchToTerminal(index) {
  if (index < 0 || index >= terminals.length) return;

  for (const t of terminals) {
    t.container.style.display = "none";
  }

  activeTermIndex = index;
  terminals[index].container.style.display = "block";

  // Double-rAF: first ensures style change is processed, second ensures layout
  // is computed. Then fit + resize the PTY so the daemon matches the display.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const entry = terminals[index];
      if (!entry) return;
      entry.fitAddon.fit();
      entry.term.refresh(0, entry.term.rows - 1);
      entry.term.focus();
      window.api.ptyResize(entry.termId, entry.term.cols, entry.term.rows);
    });
  });

  renderTerminalTabs();
}

async function closeTerminal(index) {
  if (index < 0 || index >= terminals.length) return;

  const entry = terminals[index];
  if (entry.isPoolTui) return; // Can't close the main Claude terminal
  await window.api.ptyDetach(entry.termId).catch(() => {});
  // Don't kill pool TUI terminals — the Claude process must stay alive in the pool
  if (!entry.isPoolTui) {
    await window.api.ptyKill(entry.termId);
  }
  entry.resizeObserver.disconnect();
  entry.term.dispose();
  entry.container.remove();
  terminals.splice(index, 1);

  if (terminals.length === 0) {
    activeTermIndex = -1;
    sessionView.classList.add("hidden");
    emptyState.classList.remove("hidden");
  } else {
    switchToTerminal(Math.min(index, terminals.length - 1));
  }

  // Update session cache after activeTermIndex is corrected
  syncSessionCache();
  renderTerminalTabs();
}

function renderTerminalTabs() {
  terminalTabList.innerHTML = "";
  let shellCount = 0;
  terminals.forEach((t, i) => {
    const tab = document.createElement("button");
    tab.className = `terminal-tab${i === activeTermIndex ? " active" : ""}`;
    const label = t.isPoolTui ? "Claude" : `Terminal ${++shellCount}`;
    tab.textContent = `${label} `;
    if (!t.isPoolTui) {
      const closeBtn = document.createElement("span");
      closeBtn.className = "terminal-tab-close";
      closeBtn.textContent = "\u2715";
      tab.appendChild(closeBtn);
    }
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("terminal-tab-close")) {
        closeTerminal(i);
      } else {
        switchToTerminal(i);
      }
    });
    terminalTabList.appendChild(tab);
  });
}

// Hide current session's terminals (preserve them in cache)
function hideCurrentTerminals() {
  removeInlineSnapshot();
  if (currentSessionId && terminals.length > 0) {
    sessionTerminals.set(currentSessionId, {
      terminals: [...terminals],
      activeTermIndex,
      lastAccessed: Date.now(),
    });
  }
  for (const t of terminals) {
    t.container.style.display = "none";
  }
  terminals = [];
  activeTermIndex = -1;
  terminalTabList.innerHTML = "";
}

// Restore cached terminals for a session, returns true if restored
function restoreSessionTerminals(sessionId) {
  const cached = sessionTerminals.get(sessionId);
  if (!cached || cached.terminals.length === 0) return false;

  cached.lastAccessed = Date.now();
  terminals = cached.terminals;
  activeTermIndex = cached.activeTermIndex;

  renderTerminalTabs();
  const idx = activeTermIndex >= 0 ? activeTermIndex : 0;
  switchToTerminal(idx);

  // Re-fit all terminals after restore — dimensions may have changed while hidden
  requestAnimationFrame(() => {
    for (const t of terminals) {
      if (t.container.style.display !== "none") {
        t.fitAddon.fit();
        window.api.ptyResize(t.termId, t.term.cols, t.term.rows);
      }
    }
  });

  return true;
}

// Kill and fully dispose terminals for a specific session
function destroySessionTerminals(sessionId) {
  const cached = sessionTerminals.get(sessionId);
  if (!cached) return;
  for (const entry of cached.terminals) {
    window.api.ptyDetach(entry.termId).catch(() => {});
    // Don't kill pool TUI terminals — the Claude process must stay alive
    if (!entry.isPoolTui) {
      window.api.ptyKill(entry.termId).catch(() => {});
    }
    entry.resizeObserver.disconnect();
    entry.term.dispose();
    entry.container.remove();
  }
  sessionTerminals.delete(sessionId);
}

// Kill ALL terminals across all sessions (used on new-session)
function killAllTerminals() {
  for (const [sid] of sessionTerminals) {
    destroySessionTerminals(sid);
  }
  for (const entry of terminals) {
    window.api.ptyDetach(entry.termId).catch(() => {});
    if (!entry.isPoolTui) {
      window.api.ptyKill(entry.termId).catch(() => {});
    }
    entry.resizeObserver.disconnect();
    entry.term.dispose();
    entry.container.remove();
  }
  terminals = [];
  activeTermIndex = -1;
  terminalTabList.innerHTML = "";
}

// Clean up terminals for dead sessions that haven't been accessed recently
function cleanupStaleTerminals(liveSessions) {
  const aliveIds = new Set(
    liveSessions.filter((s) => s.alive).map((s) => s.sessionId),
  );
  const now = Date.now();
  for (const [sid, cached] of sessionTerminals) {
    if (sid === currentSessionId) continue; // never clean up active session
    const isDead = !aliveIds.has(sid);
    const isStale = now - cached.lastAccessed > CLEANUP_AFTER_MS;
    if (isDead && isStale) {
      destroySessionTerminals(sid);
    }
  }
}

// Find a terminal entry across all sessions (active + cached)
// Temporary lookup for terminals being reconnected (before they're in sessionTerminals)
const pendingTerminals = new Map(); // termId -> entry
const popupTerminals = new Map(); // termId -> { term, ... } for slot terminal popups

function findTerminalEntry(termId) {
  const active = terminals.find((t) => t.termId === termId);
  if (active) return active;
  for (const cached of sessionTerminals.values()) {
    const entry = cached.terminals.find((t) => t.termId === termId);
    if (entry) return entry;
  }
  return pendingTerminals.get(termId) || null;
}

// Wire PTY output from daemon (via main process)
window.api.onPtyData((termId, data) => {
  const entry = findTerminalEntry(termId);
  if (entry) entry.term.write(data);
  // Also forward to popup terminal if open (may be same or different entry)
  const popup = popupTerminals.get(termId);
  if (popup && popup !== entry) popup.term.write(data);
});

window.api.onPtyReplay((termId, data) => {
  const entry = findTerminalEntry(termId);
  // Skip if buffer was already written directly during reconnect
  if (entry && !entry.skipReplay) entry.term.write(data);
  // Popup always receives replay (it never has skipReplay)
  const popup = popupTerminals.get(termId);
  if (popup && popup !== entry) popup.term.write(data);
});

window.api.onPtyExit((termId) => {
  const entry = findTerminalEntry(termId);
  if (entry) entry.term.write("\r\n[Process exited]\r\n");
  const popup = popupTerminals.get(termId);
  if (popup && popup !== entry) popup.term.write("\r\n[Process exited]\r\n");
});

const STATUS_CLASSES = {
  idle: "idle",
  processing: "processing",
  fresh: "fresh",
  typing: "typing",
  dead: "dead",
  offloaded: "offloaded",
  archived: "archived",
};

// Build a fingerprint for a session to detect changes
function sessionFingerprint(s) {
  return `${s.sessionId}|${s.status}|${s.staleIdle ? "stale" : ""}|${s.intentionHeading || ""}|${s.cwd || ""}|${s.origin || ""}`;
}

// Track previous session fingerprints for diff-based updates
let prevSessionFingerprints = null;
let archiveExpanded = false;
async function loadSessions() {
  const sessions = await window.api.getSessions();
  cachedSessions = sessions;
  cleanupStaleTerminals(sessions);
  updatePoolHealthBadge();

  // Split into sections — pool and external mixed together
  const typing = sessions.filter((s) => s.status === "typing");
  const recent = sessions.filter(
    (s) => s.status === "idle" || s.status === "offloaded",
  );
  const processing = sessions.filter((s) => s.status === "processing");
  const archived = sessions.filter((s) => s.status === "archived");

  // Build fingerprint to check if anything changed
  const allItems = [...typing, ...recent, ...processing, ...archived];
  const fingerprints = allItems.map(sessionFingerprint).join("\n");
  if (fingerprints === prevSessionFingerprints) {
    // Only update active class (selected session may have changed)
    for (const li of sessionList.querySelectorAll(".session-item")) {
      li.classList.toggle("active", li.dataset.sessionId === currentSessionId);
    }
    return;
  }
  prevSessionFingerprints = fingerprints;

  // Full rebuild only when sessions actually changed
  sessionList.innerHTML = "";

  if (
    typing.length === 0 &&
    recent.length === 0 &&
    processing.length === 0 &&
    archived.length === 0
  ) {
    sessionList.innerHTML =
      '<li style="padding: 12px; color: var(--text-dim); font-size: 13px;">No sessions found</li>';
    return;
  }

  function addSection(label, items) {
    if (items.length === 0) return;
    const header = document.createElement("li");
    header.className = "session-section-header";
    header.textContent = `${label} (${items.length})`;
    sessionList.appendChild(header);
    for (const s of items) {
      sessionList.appendChild(createSessionItem(s));
    }
  }

  addSection("Typing", typing);
  addSection("Recent", recent);
  addSection("Processing", processing);

  // Archive section: collapsible, shows first 5 by default
  if (archived.length > 0) {
    const ARCHIVE_VISIBLE = 5;
    const header = document.createElement("li");
    header.className = "session-section-header session-section-collapsible";
    const collapsed = archived.length > ARCHIVE_VISIBLE && !archiveExpanded;
    header.innerHTML = `<span class="section-toggle">${archiveExpanded ? "▾" : "▸"}</span> Archive (${archived.length})`;
    if (archived.length > ARCHIVE_VISIBLE) {
      header.addEventListener("click", () => {
        archiveExpanded = !archiveExpanded;
        loadSessions();
      });
    }
    sessionList.appendChild(header);
    const visible = collapsed ? archived.slice(0, ARCHIVE_VISIBLE) : archived;
    for (const s of visible) {
      sessionList.appendChild(createSessionItem(s));
    }
    if (collapsed) {
      const more = document.createElement("li");
      more.className = "session-section-more";
      more.textContent = `+${archived.length - ARCHIVE_VISIBLE} more`;
      more.addEventListener("click", () => {
        archiveExpanded = true;
        loadSessions();
      });
      sessionList.appendChild(more);
    }
  }
}

function createSessionItem(s) {
  const li = document.createElement("li");
  li.className = `session-item${s.sessionId === currentSessionId ? " active" : ""}${s.status === "offloaded" || s.status === "archived" ? " offloaded" : ""}`;
  li.dataset.sessionId = s.sessionId;
  const heading = s.intentionHeading || "No intention yet";
  const dp = displayPath(s);
  const dirColor = getDirColor(s);
  const indicatorStyle = dirColor
    ? `background: ${dirColor}; box-shadow: 0 0 4px ${dirColor}`
    : "background: transparent";
  const showOrigin =
    s.origin && s.status !== "offloaded" && s.status !== "archived";
  const originTag = showOrigin
    ? `<span class="session-origin-tag session-origin-${escapeHtml(s.origin)}">${escapeHtml(s.origin)}</span>`
    : "";
  const staleTag = s.staleIdle
    ? `<span class="session-origin-tag session-origin-stale">stale</span>`
    : "";
  li.innerHTML = `
    <div class="session-dir-indicator" style="${indicatorStyle}"></div>
    <div class="session-item-content">
      <div class="session-project">
        <span class="session-status ${STATUS_CLASSES[s.status] || "dead"}"></span>
        ${escapeHtml(heading)}
        ${originTag}${staleTag}
      </div>
      <div class="session-cwd">${escapeHtml(dp)}</div>
    </div>
  `;
  li.addEventListener("click", () => selectSession(s));
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showSessionContextMenu(e, s);
  });
  return li;
}

// Right-click context menu for sessions
function showSessionContextMenu(e, session) {
  const existing = document.getElementById("session-context-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.id = "session-context-menu";
  menu.className = "session-context-menu";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const isArchived = session.status === "archived";
  const isOffloaded = session.status === "offloaded";

  if (isArchived) {
    menu.innerHTML = `
      <div class="session-context-item" data-action="restart">Restart</div>
      <div class="session-context-item" data-action="unarchive">Move to Recent</div>
    `;
  } else if (isOffloaded) {
    menu.innerHTML = `
      <div class="session-context-item" data-action="resume">Resume</div>
      <div class="session-context-item" data-action="archive">Archive</div>
    `;
  } else {
    menu.innerHTML = `
      <div class="session-context-item" data-action="archive">Archive</div>
    `;
  }

  document.body.appendChild(menu);

  const close = () => menu.remove();
  setTimeout(() => document.addEventListener("click", close, { once: true }));

  menu.addEventListener("click", async (ev) => {
    const action = ev.target.dataset.action;
    menu.remove();
    if (action === "archive") {
      try {
        await window.api.archiveSession(session.sessionId);
      } catch (err) {
        console.error("Failed to archive session:", err);
      }
      await loadSessions();
    } else if (action === "unarchive") {
      try {
        await window.api.unarchiveSession(session.sessionId);
      } catch (err) {
        console.error("Failed to unarchive session:", err);
      }
      await loadSessions();
    } else if (action === "restart") {
      try {
        await window.api.unarchiveSession(session.sessionId);
      } catch (err) {
        console.error("Failed to unarchive session for restart:", err);
      }
      await resumeOffloadedSession(session);
    } else if (action === "resume") {
      await resumeOffloadedSession(session);
    }
  });
}

// Show read-only snapshot viewer
function showSnapshotViewer(session, snapshotText) {
  const existing = document.getElementById("snapshot-viewer");
  if (existing) existing.remove();

  const viewer = document.createElement("div");
  viewer.id = "snapshot-viewer";
  viewer.className = "offload-menu-overlay";
  viewer.innerHTML = `
    <div class="snapshot-dialog">
      <div class="snapshot-header">
        <span>${escapeHtml(session.intentionHeading || "Snapshot")}</span>
        <button class="snapshot-close">\u2715</button>
      </div>
      <pre class="snapshot-content">${snapshotText ? escapeHtml(snapshotText) : "(no snapshot available)"}</pre>
    </div>
  `;

  document.body.appendChild(viewer);
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) viewer.remove();
  });
  viewer.querySelector(".snapshot-close").addEventListener("click", () => {
    viewer.remove();
  });
}

// Show snapshot content inline in the terminal pane for offloaded/archived sessions
async function showInlineSnapshot(session, gen) {
  const terminalPane = document.getElementById("terminal-pane");
  const isArchived = session.status === "archived";
  const btnLabel = isArchived ? "Restart" : "Resume";

  let snapshotText = null;
  if (session.hasSnapshot) {
    try {
      snapshotText = await window.api.readOffloadSnapshot(session.sessionId);
    } catch (err) {
      debugLog("snapshot", `failed to read snapshot: ${err.message}`);
    }
    if (gen !== sessionGeneration) return;
  }

  // Hide terminal tabs and mount, replace with snapshot view
  terminalTabList.style.display = "none";
  newTermBtn.style.display = "none";
  terminalMount.style.display = "none";

  // Remove any previous inline snapshot
  const prev = document.getElementById("inline-snapshot");
  if (prev) prev.remove();

  const container = document.createElement("div");
  container.id = "inline-snapshot";
  container.innerHTML = `
    <div class="inline-snapshot-header">
      <span class="inline-snapshot-label">${isArchived ? "Archived" : "Offloaded"} Session</span>
      <button class="inline-snapshot-restart">${btnLabel}</button>
    </div>
    <pre class="snapshot-content inline-snapshot-content">${snapshotText ? escapeHtml(snapshotText) : "(no snapshot available)"}</pre>
  `;
  terminalPane.appendChild(container);

  container
    .querySelector(".inline-snapshot-restart")
    .addEventListener("click", async () => {
      if (isArchived) {
        try {
          await window.api.unarchiveSession(session.sessionId);
        } catch (err) {
          debugLog("snapshot", `unarchive failed: ${err.message}`);
        }
      }
      await resumeOffloadedSession(session);
    });
}

// Clean up inline snapshot when switching away from an offloaded/archived session
function removeInlineSnapshot() {
  const snap = document.getElementById("inline-snapshot");
  if (!snap) return;
  snap.remove();
  terminalTabList.style.display = "";
  newTermBtn.style.display = "";
  terminalMount.style.display = "";
}

function displayPath(session) {
  return session.cwd ? session.cwd.replace(session.home, "~") : "~";
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isFreshPoolSlot(s) {
  return (
    s.origin === "pool" && (s.status === "fresh" || s.poolStatus === "fresh")
  );
}

// Acquire a fresh slot: prefer existing fresh, else offload LRU idle.
// Returns the fresh session object or null if pool is fully busy.
async function acquireFreshSlot() {
  const sessions = await window.api.getSessions();

  // 1. Prefer an existing fresh slot (poolStatus is set by main process)
  const freshSession = sessions.find(isFreshPoolSlot);
  if (freshSession) return freshSession;

  // No pool sessions at all — nothing to acquire from
  if (!sessions.some((s) => s.origin === "pool")) return null;

  // 2. Offload the longest-unused idle session (LRU)
  const idleSessions = sessions
    .filter(
      (s) =>
        s.status === "idle" &&
        s.origin === "pool" &&
        s.sessionId !== currentSessionId,
    )
    .sort((a, b) => a.idleTs - b.idleTs);

  if (idleSessions.length === 0) return null; // All slots busy — can't acquire

  const victim = idleSessions[0];

  // Find the victim's terminal from pool data (need termId for offload)
  const pool = await window.api.poolRead();
  const victimSlot = pool?.slots.find((s) => s.sessionId === victim.sessionId);
  if (!victimSlot) return null;

  try {
    await window.api.offloadSession(
      victim.sessionId,
      victimSlot.termId,
      victim.sessionId, // Claude session UUID = our session ID (same value from hook)
      { cwd: victim.cwd, gitRoot: victim.gitRoot, pid: victim.pid },
    );
  } catch (err) {
    debugLog("pool", `offload failed session=${victim.sessionId}`, err.message);
    return null;
  }

  // Poll until the slot becomes fresh (idle signal changes after /clear)
  debugLog(
    "pool",
    `polling for fresh slot after offload of ${victim.sessionId}`,
  );
  const fresh = await pollForFreshSlot(30000);
  if (fresh) {
    destroySessionTerminals(victim.sessionId);
  }
  return fresh;
}

// Poll getSessions() until a fresh pool slot appears
async function pollForFreshSlot(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    const sessions = await window.api.getSessions();
    const fresh = sessions.find(isFreshPoolSlot);
    if (fresh) {
      debugLog("pool", `fresh slot found: ${fresh.sessionId}`);
      return fresh;
    }
  }
  debugLog("pool", `poll timed out after ${timeoutMs}ms — no fresh slot`);
  return null;
}

// Resume an offloaded session into a fresh slot
async function resumeOffloadedSession(session) {
  let result;
  try {
    result = await window.api.poolResume(session.sessionId);
    showNotification(`Resuming session in slot ${result.slotIndex}…`);
  } catch (err) {
    debugLog("pool", `resume failed session=${session.sessionId}`, err.message);
    showNotification(`Resume failed: ${err.message}`);
    return;
  }

  // Transition: remove inline snapshot, attach to the live slot terminal
  removeInlineSnapshot();
  try {
    await attachPoolTerminal(result.termId);
  } catch (err) {
    debugLog("pool", `attach after resume failed: ${err.message}`);
  }

  // Poll until the slot gets its new session ID, then update our state
  const oldSessionId = session.sessionId;
  const newSession = await pollForResumedSession(result.termId, 60000);
  if (newSession) {
    currentSessionId = newSession.sessionId;
    currentSessionCwd = newSession.cwd;
    // Move terminal cache from old to new session ID
    sessionTerminals.delete(oldSessionId);
    if (terminals.length > 0) {
      sessionTerminals.set(newSession.sessionId, {
        terminals: [...terminals],
        activeTermIndex,
        lastAccessed: Date.now(),
      });
    }
  }
  await loadSessions();
}

// Poll getSessions until we find the session in a given pool slot
async function pollForResumedSession(termId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    const pool = await window.api.poolRead();
    if (!pool) continue;
    const slot = pool.slots.find(
      (s) => s.termId === termId && s.status !== "fresh",
    );
    if (slot?.sessionId) {
      const sessions = await window.api.getSessions();
      const match = sessions.find((s) => s.sessionId === slot.sessionId);
      if (match) return match;
    }
  }
  debugLog("pool", `poll for resumed session timed out after ${timeoutMs}ms`);
  return null;
}

function showNotification(msg) {
  saveStatus.textContent = msg;
  setTimeout(() => {
    if (saveStatus.textContent === msg) saveStatus.textContent = "";
  }, 3000);
}

// Corner toast for important system events (auto-recovery, errors)
function showToast(msg, level = "info") {
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
    // Fallback if animation is disabled (prefers-reduced-motion)
    setTimeout(() => toast.remove(), 300);
  }
  const autoId = setTimeout(dismiss, 8000);
  toast.addEventListener("click", () => {
    clearTimeout(autoId);
    dismiss();
  });
}

async function selectSession(session) {
  // If already viewing this session, nothing to do
  if (session.sessionId === currentSessionId) return;

  hideCurrentTerminals();

  currentSessionId = session.sessionId;
  currentSessionCwd = session.cwd;
  const gen = ++sessionGeneration;
  debugLog(
    "session",
    `select ${session.sessionId} gen=${gen} origin=${session.origin}`,
  );

  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.sessionId === session.sessionId);
  });

  emptyState.classList.add("hidden");
  sessionView.classList.remove("hidden");
  editorPane.classList.remove("hidden");
  editorProject.textContent = session.project
    ? `${session.project} — ${displayPath(session)}`
    : session.sessionId;

  // Apply directory color to editor header
  const dirColor = getDirColor(session);
  const header = document.getElementById("editor-header");
  const existingBar = header.querySelector("#editor-header-color-bar");
  if (existingBar) existingBar.remove();
  if (dirColor) {
    const colorBar = document.createElement("div");
    colorBar.id = "editor-header-color-bar";
    colorBar.style.background = dirColor;
    colorBar.style.boxShadow = `0 0 8px ${dirColor}`;
    header.appendChild(colorBar);
  }

  // Offloaded/archived: show snapshot inline instead of a terminal
  if (session.status === "offloaded" || session.status === "archived") {
    showInlineSnapshot(session, gen);
  } else if (!restoreSessionTerminals(session.sessionId)) {
    // Restore cached terminals immediately (sync, no race risk)
    if (session.origin === "pool") {
      // Pool session: attach to the pool slot's existing Claude TUI
      const pool = await window.api.poolRead();
      if (gen !== sessionGeneration) {
        debugLog("session", `race abort gen=${gen} at poolRead`);
        return;
      }
      const slot = pool?.slots.find((s) => s.sessionId === session.sessionId);
      if (slot) {
        try {
          const entry = await attachPoolTerminal(slot.termId);
          if (gen !== sessionGeneration) {
            debugLog("session", `race abort gen=${gen} at poolAttach`);
            destroySessionTerminals(session.sessionId);
            return;
          }
        } catch {
          debugLog(
            "session",
            `pool attach failed for slot ${slot.termId}, falling back to shell`,
          );
          const entry = await spawnTerminal(session.cwd);
          if (gen !== sessionGeneration) {
            debugLog("session", `race abort gen=${gen} at spawnFallback`);
            destroySessionTerminals(session.sessionId);
            return;
          }
        }
      } else {
        // No pool slot found — fall back to fresh shell
        const entry = await spawnTerminal(session.cwd);
        if (gen !== sessionGeneration) {
          debugLog("session", `race abort gen=${gen} at noSlotSpawn`);
          destroySessionTerminals(session.sessionId);
          return;
        }
      }
    } else {
      // External session: spawn a fresh shell
      const entry = await spawnTerminal(session.cwd);
      if (gen !== sessionGeneration) {
        debugLog("session", `race abort gen=${gen} at extSpawn`);
        destroySessionTerminals(session.sessionId);
        return;
      }
    }
  }

  const content = await window.api.readIntention(session.sessionId);
  if (gen !== sessionGeneration) return;
  createEditor(content);
  saveStatus.textContent = "";

  await window.api.watchIntention(session.sessionId);
}

// "+" in sidebar: acquire a fresh slot from the pool (or offload LRU idle)
// --- Setup script picker ---
function showSetupScriptPicker(scripts) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "setup-script-overlay";

    const dialog = document.createElement("div");
    dialog.className = "setup-script-dialog";

    const title = document.createElement("div");
    title.className = "setup-script-title";
    title.textContent = "Setup Script";
    dialog.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "setup-script-subtitle";
    subtitle.textContent = "Run a script in the new session";
    dialog.appendChild(subtitle);

    const list = document.createElement("div");
    list.className = "setup-script-list";

    let selectedIndex = 0;
    const items = [];

    // "None" option first
    const allOptions = ["None", ...scripts];

    for (let i = 0; i < allOptions.length; i++) {
      const item = document.createElement("div");
      item.className = "setup-script-item";
      if (i === 0) item.classList.add("selected");
      item.textContent = allOptions[i];
      item.addEventListener("click", () => {
        cleanup();
        resolve(i === 0 ? null : allOptions[i]);
      });
      list.appendChild(item);
      items.push(item);
    }

    dialog.appendChild(list);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function updateSelection() {
      items.forEach((el, i) =>
        el.classList.toggle("selected", i === selectedIndex),
      );
      items[selectedIndex].scrollIntoView({ block: "nearest" });
    }

    function cleanup() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    }

    function onKey(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % allOptions.length;
        updateSelection();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIndex =
          (selectedIndex - 1 + allOptions.length) % allOptions.length;
        updateSelection();
      } else if (e.key === "Enter") {
        e.preventDefault();
        cleanup();
        resolve(selectedIndex === 0 ? null : allOptions[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    }

    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    });
  });
}

async function typeSetupScript(termId, scriptContent) {
  // Each line is typed literally; \r in the text becomes a carriage return
  const processed = scriptContent.replace(/\\r/g, "\r");
  await window.api.ptyWrite(termId, processed);
}

newSessionBtn.addEventListener("click", async () => {
  // Check pool is initialized
  const pool = await window.api.poolRead();
  if (!pool) {
    showNotification("Pool not initialized — open pool settings");
    return;
  }

  // Check for setup scripts before acquiring a slot
  let selectedScript = null;
  const scripts = await window.api.listSetupScripts();
  if (scripts.length > 0) {
    selectedScript = await showSetupScriptPicker(scripts);
    // null means "None" or Escape — proceed without script
  }

  const freshSlot = await acquireFreshSlot();
  if (!freshSlot) {
    showNotification(
      "All pool slots are busy — wait for a session to finish or resize pool",
    );
    return;
  }

  await selectSession(freshSlot);

  // Type setup script into the session's terminal
  if (selectedScript) {
    const content = await window.api.readSetupScript(selectedScript);
    if (content) {
      const poolData = await window.api.poolRead();
      const slot = poolData?.slots.find(
        (s) => s.sessionId === freshSlot.sessionId,
      );
      if (slot) {
        await typeSetupScript(slot.termId, content);
      }
    }
  }

  await loadSessions();
});

// "+" in terminal tab bar: new terminal at current session's CWD
newTermBtn.addEventListener("click", async () => {
  await spawnTerminal(currentSessionCwd);
});

function scheduleSave() {
  if (!currentSessionId || !editorView) return;
  saveStatus.textContent = "Editing...";
  updateTypingState();
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const content = editorView.state.doc.toString();
    try {
      await window.api.writeIntention(currentSessionId, content);
      saveStatus.textContent = "Saved";
      setTimeout(() => {
        if (saveStatus.textContent === "Saved") saveStatus.textContent = "";
      }, 2000);
    } catch (err) {
      debugLog(
        "editor",
        `intention save failed session=${currentSessionId}`,
        err.message,
      );
      saveStatus.textContent = "";
    }
  }, 500);
}

let typingRefreshTimeout;

function invalidateSidebar() {
  prevSessionFingerprints = null;
  loadSessions();
}

// After editing a fresh/typing session, refresh sidebar so main re-checks intention file
function updateTypingState() {
  if (!currentSessionId) return;
  const session = cachedSessions.find((s) => s.sessionId === currentSessionId);
  if (!session || (session.status !== "fresh" && session.status !== "typing")) {
    return;
  }
  // Sidebar will refresh after the debounced save writes the file
  // Main process detects content from the file, so just invalidate
  clearTimeout(typingRefreshTimeout);
  typingRefreshTimeout = setTimeout(invalidateSidebar, 600); // after 500ms save debounce
}

// Handle external file changes
window.api.onIntentionChanged((content) => {
  if (!editorView) return;
  const current = editorView.state.doc.toString();
  if (content !== current) {
    editorView.dispatch({
      changes: { from: 0, to: current.length, insert: content },
    });
    saveStatus.textContent = "Updated from disk";
    setTimeout(() => {
      if (saveStatus.textContent === "Updated from disk")
        saveStatus.textContent = "";
    }, 2000);
  }
});

// --- Session switching ---
function switchSession(direction) {
  // Navigate between loaded sessions (idle + processing + typing), skip offloaded/fresh/dead
  const navigable = cachedSessions.filter(
    (s) =>
      s.alive &&
      (s.status === "idle" ||
        s.status === "processing" ||
        s.status === "typing"),
  );
  if (navigable.length === 0) return;
  const currentIndex = navigable.findIndex(
    (s) => s.sessionId === currentSessionId,
  );
  let nextIndex;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex =
      (currentIndex + direction + navigable.length) % navigable.length;
  }
  selectSession(navigable[nextIndex]);
}

// --- Jump to most recent idle session ---
function jumpToRecentIdle() {
  const idle = cachedSessions.find(
    (s) => s.status === "idle" && s.sessionId !== currentSessionId,
  );
  if (idle) selectSession(idle);
}

// --- Focus external terminal for current session ---
async function focusCurrentExternalTerminal() {
  const session = cachedSessions.find((s) => s.sessionId === currentSessionId);
  if (!session || !session.alive || session.origin === "pool") return;
  const result = await window.api.focusExternalTerminal(session.pid);
  if (result.focused) showNotification(`Focused ${result.app}`);
}

// --- Archive current session (then jump to recent idle) ---
async function archiveCurrentSession() {
  if (!currentSessionId) return;
  const session = cachedSessions.find((s) => s.sessionId === currentSessionId);
  if (!session) return;
  // Can't archive already-archived sessions
  if (session.status === "archived") return;

  const archivingSessionId = currentSessionId;

  // Jump away immediately — don't wait for the slow offload+/clear
  const idle = cachedSessions.find(
    (s) =>
      s.sessionId !== archivingSessionId &&
      (s.status === "idle" || s.status === "fresh" || s.status === "typing"),
  );
  if (idle) {
    selectSession(idle);
  }

  // Archive in background
  try {
    await window.api.archiveSession(archivingSessionId);
  } catch (err) {
    console.error("Failed to archive session:", err);
  }
  await loadSessions();
}

// --- Sidebar toggle ---
function toggleSidebar() {
  sidebar.classList.toggle("collapsed");
}

// --- Focus management ---
function focusTerminal() {
  if (activeTermIndex >= 0 && terminals[activeTermIndex]) {
    terminals[activeTermIndex].term.focus();
  }
}

function focusEditor() {
  if (editorView) editorView.focus();
}

// --- Command palette ---
// --- Shortcut display helpers ---
// Convert Electron accelerator to display string (e.g. "CmdOrCtrl+N" → "⌘N")
function formatShortcutDisplay(accel) {
  if (!accel) return "";
  return accel
    .replace(/CmdOrCtrl\+/gi, "⌘")
    .replace(/Cmd\+/gi, "⌘")
    .replace(/Ctrl\+/gi, "⌃")
    .replace(/Shift\+/gi, "⇧")
    .replace(/Alt\+/gi, "⌥")
    .replace(/\+/g, "")
    .replace(/Tab/gi, "⇥")
    .replace(/Up/gi, "↑")
    .replace(/Down/gi, "↓")
    .replace(/Left/gi, "←")
    .replace(/Right/gi, "→");
}

// Loaded shortcut config (populated on init)
let shortcutConfig = {};

// Cycle pane focus: editor → terminal tabs (round-robin) → back to editor
function cyclePane() {
  if (editorMount.contains(document.activeElement)) {
    // Editor focused → go to first terminal
    focusTerminal();
  } else if (activeTermIndex >= 0 && terminals.length > 1) {
    // On a terminal tab — cycle to next, or wrap to editor
    const nextIdx = activeTermIndex + 1;
    if (nextIdx < terminals.length) {
      switchToTerminal(nextIdx);
    } else {
      focusEditor();
    }
  } else {
    // On terminal (single) or somewhere else → go to editor
    focusEditor();
  }
}

const COMMANDS = [
  {
    id: "next-session",
    label: "Next Session",
    shortcutAction: "next-session",
    action: () => switchSession(1),
  },
  {
    id: "prev-session",
    label: "Previous Session",
    shortcutAction: "prev-session",
    action: () => switchSession(-1),
  },
  {
    id: "new-session",
    label: "New Claude Session",
    shortcutAction: "new-session",
    action: () => newSessionBtn.click(),
  },
  {
    id: "new-terminal",
    label: "New Terminal Tab",
    shortcutAction: "new-terminal-tab",
    action: () => {
      if (currentSessionId) spawnTerminal(currentSessionCwd);
    },
  },
  {
    id: "close-terminal",
    label: "Close Terminal Tab",
    shortcutAction: "close-terminal-tab",
    action: () => {
      if (activeTermIndex >= 0) closeTerminal(activeTermIndex);
    },
  },
  {
    id: "next-tab",
    label: "Next Terminal Tab",
    shortcutAction: "next-tab",
    action: () => {
      if (terminals.length > 1)
        switchToTerminal((activeTermIndex + 1) % terminals.length);
    },
  },
  {
    id: "prev-tab",
    label: "Previous Terminal Tab",
    shortcutAction: "prev-tab",
    action: () => {
      if (terminals.length > 1)
        switchToTerminal(
          (activeTermIndex - 1 + terminals.length) % terminals.length,
        );
    },
  },
  {
    id: "jump-recent-idle",
    label: "Jump to Recent Idle",
    shortcutAction: "jump-recent-idle",
    action: jumpToRecentIdle,
  },
  {
    id: "archive-current-session",
    label: "Archive Current Session",
    shortcutAction: "archive-current-session",
    action: archiveCurrentSession,
  },
  {
    id: "toggle-sidebar",
    label: "Toggle Sidebar",
    shortcutAction: "toggle-sidebar",
    action: toggleSidebar,
  },
  {
    id: "cycle-pane",
    label: "Cycle Pane Focus",
    shortcutAction: "cycle-pane",
    action: cyclePane,
  },
  {
    id: "toggle-pane-focus",
    label: "Toggle Pane Focus",
    shortcutAction: "toggle-pane-focus",
    action: () => {
      if (editorMount.contains(document.activeElement)) {
        focusTerminal();
      } else {
        focusEditor();
      }
    },
  },
  {
    id: "focus-editor",
    label: "Focus Editor",
    shortcutAction: "focus-editor",
    action: focusEditor,
  },
  {
    id: "focus-terminal",
    label: "Focus Terminal",
    shortcutAction: "focus-terminal",
    action: focusTerminal,
  },
  {
    id: "focus-external-terminal",
    label: "Focus External Terminal",
    shortcutAction: "focus-external",
    action: focusCurrentExternalTerminal,
  },
  {
    id: "refresh",
    label: "Refresh Sessions",
    action: () => {
      loadDirColors();
      loadSessions();
    },
  },
  {
    id: "command-palette",
    label: "Command Palette",
    shortcutAction: "toggle-command-palette",
    action: () => toggleCommandPalette(),
  },
];

// Also add Tab 1-9 commands
for (let i = 0; i < 9; i++) {
  COMMANDS.push({
    id: `tab-${i + 1}`,
    label: `Switch to Tab ${i + 1}`,
    shortcut: `⌘${i + 1}`,
    action: () => {
      if (i < terminals.length) switchToTerminal(i);
    },
  });
}

let paletteSelectedIndex = 0;
let filteredCommands = [];

function toggleCommandPalette() {
  if (commandPalette.classList.contains("visible")) {
    closeCommandPalette();
  } else {
    openCommandPalette();
  }
}

function openCommandPalette() {
  commandPalette.classList.add("visible");
  commandPaletteInput.value = "";
  paletteSelectedIndex = 0;
  renderPaletteList("");
  commandPaletteInput.focus();
}

function closeCommandPalette() {
  commandPalette.classList.remove("visible");
  commandPaletteInput.value = "";
  // Return focus to terminal
  focusTerminal();
}

// Get display shortcut for a command (dynamic from config)
function getCommandShortcut(cmd) {
  if (!cmd.shortcutAction) return "";
  return formatShortcutDisplay(shortcutConfig[cmd.shortcutAction] || "");
}

function renderPaletteList(query) {
  const q = query.toLowerCase();
  filteredCommands = q
    ? COMMANDS.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          getCommandShortcut(c).toLowerCase().includes(q),
      )
    : COMMANDS.filter((c) => !c.id.startsWith("tab-")); // Hide tab-N from unfiltered list

  paletteSelectedIndex = Math.min(
    paletteSelectedIndex,
    Math.max(0, filteredCommands.length - 1),
  );

  commandPaletteList.innerHTML = "";
  filteredCommands.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = `command-palette-item${i === paletteSelectedIndex ? " selected" : ""}`;
    const shortcut = getCommandShortcut(cmd);
    item.innerHTML = `<span class="command-palette-label">${cmd.label}</span><span class="command-palette-shortcut">${shortcut}</span>`;
    item.addEventListener("click", () => {
      closeCommandPalette();
      cmd.action();
    });
    item.addEventListener("mouseenter", () => updatePaletteSelection(i));
    commandPaletteList.appendChild(item);
  });
}

commandPaletteInput.addEventListener("input", () => {
  paletteSelectedIndex = 0;
  renderPaletteList(commandPaletteInput.value);
});

function updatePaletteSelection(newIndex) {
  const items = commandPaletteList.children;
  if (items[paletteSelectedIndex])
    items[paletteSelectedIndex].classList.remove("selected");
  paletteSelectedIndex = newIndex;
  if (items[paletteSelectedIndex]) {
    items[paletteSelectedIndex].classList.add("selected");
    items[paletteSelectedIndex].scrollIntoView({ block: "nearest" });
  }
}

commandPaletteInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeCommandPalette();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    updatePaletteSelection(
      Math.min(paletteSelectedIndex + 1, filteredCommands.length - 1),
    );
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    updatePaletteSelection(Math.max(paletteSelectedIndex - 1, 0));
    return;
  }
  if (e.key === "Enter" && filteredCommands.length > 0) {
    e.preventDefault();
    const cmd = filteredCommands[paletteSelectedIndex];
    closeCommandPalette();
    cmd.action();
    return;
  }
});

// Click outside palette to close
commandPalette.addEventListener("click", (e) => {
  if (e.target === commandPalette) closeCommandPalette();
});

// Menu keyboard shortcuts
window.api.onNewTerminalTab(() => {
  if (currentSessionId) spawnTerminal(currentSessionCwd);
});

window.api.onCloseTerminalTab(() => {
  if (activeTermIndex >= 0) closeTerminal(activeTermIndex);
});

window.api.onNextTerminalTab(() => {
  if (terminals.length > 1) {
    switchToTerminal((activeTermIndex + 1) % terminals.length);
  }
});

window.api.onPrevTerminalTab(() => {
  if (terminals.length > 1) {
    switchToTerminal(
      (activeTermIndex - 1 + terminals.length) % terminals.length,
    );
  }
});

window.api.onSwitchTerminalTab((index) => {
  if (index < terminals.length) switchToTerminal(index);
});

// Navigation shortcuts
window.api.onNewSession(() => newSessionBtn.click());
window.api.onNextSession(() => switchSession(1));
window.api.onPrevSession(() => switchSession(-1));
window.api.onToggleSidebar(toggleSidebar);
window.api.onFocusEditor(focusEditor);
window.api.onFocusTerminal(() => {
  // Don't steal focus from command palette (Escape closes it instead)
  if (!commandPalette.classList.contains("visible")) focusTerminal();
});
window.api.onToggleCommandPalette(toggleCommandPalette);
window.api.onTogglePaneFocus(() => {
  // If editor is focused, go to terminal; otherwise go to editor
  if (editorMount.contains(document.activeElement)) {
    focusTerminal();
  } else {
    focusEditor();
  }
});
window.api.onCyclePane(cyclePane);
window.api.onFocusExternalTerminal(focusCurrentExternalTerminal);
window.api.onJumpRecentIdle(jumpToRecentIdle);
window.api.onArchiveCurrentSession(archiveCurrentSession);

// Pool slot recovery toast
window.api.onPoolSlotsRecovered((slots) => {
  const reasons = slots.map((s) => `slot ${s.index} (${s.reason})`).join(", ");
  const msg = `Auto-recovered ${slots.length} pool slot${slots.length > 1 ? "s" : ""}: ${reasons}`;
  debugLog("pool", msg);
  showToast(msg, "warning");
});

// Reconnect a single PTY from daemon (after app restart or reload)
async function reconnectTerminal(ptyInfo) {
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;display:none;";
  terminalMount.appendChild(container);

  // Match the PTY's current dimensions so replay buffer renders correctly
  const term = createTerminal({
    ...(ptyInfo.cols && { cols: ptyInfo.cols }),
    ...(ptyInfo.rows && { rows: ptyInfo.rows }),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const entry = {
    termId: ptyInfo.termId,
    pid: ptyInfo.pid,
    term,
    fitAddon,
    resizeObserver: null,
    container,
    isPoolTui: !!ptyInfo.isPoolTui,
  };

  // Write buffered output directly (already available from ptyList response)
  if (ptyInfo.buffer) {
    term.write(ptyInfo.buffer);
    entry.skipReplay = true; // Suppress duplicate daemon replay
  }

  // Register before attach so any new data arriving can find this terminal
  pendingTerminals.set(ptyInfo.termId, entry);

  // Attach to daemon for future data
  try {
    await window.api.ptyAttach(ptyInfo.termId);
  } catch (err) {
    pendingTerminals.delete(ptyInfo.termId);
    term.dispose();
    container.remove();
    throw err;
  }

  pendingTerminals.delete(ptyInfo.termId);

  if (ptyInfo.exited) term.write("\r\n[Process exited]\r\n");

  term.onData((data) => window.api.ptyWrite(ptyInfo.termId, data));

  const resizeObserver = new ResizeObserver(() => {
    if (container.style.display !== "none") {
      fitAddon.fit();
      window.api.ptyResize(ptyInfo.termId, term.cols, term.rows);
    }
  });
  resizeObserver.observe(terminalMount);
  entry.resizeObserver = resizeObserver;

  return entry;
}

// On app start: reconnect to any PTYs that survived from previous instance
async function reconnectAllPtys() {
  const ptys = await window.api.ptyList();
  debugLog("startup", `reconnecting ${ptys.length} PTYs`);
  if (ptys.length === 0) return;

  // Identify pool slot termIds so we can tag reconnected terminals
  const pool = await window.api.poolRead();
  const poolTermIds = new Set();
  if (pool) {
    for (const slot of pool.slots) {
      poolTermIds.add(slot.termId);
    }
  }

  // Group by sessionId
  const bySession = new Map();
  for (const p of ptys) {
    p.isPoolTui = poolTermIds.has(p.termId);
    const sid = p.sessionId || "__none__";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(p);
  }

  // Reconnect each session's terminals (skip orphaned terminals with no session)
  for (const [sid, sessionPtys] of bySession) {
    if (sid === "__none__") {
      debugLog("startup", `detaching ${sessionPtys.length} orphaned PTYs`);
      for (const p of sessionPtys) {
        window.api.ptyDetach(p.termId).catch(() => {});
      }
      continue;
    }
    const entries = [];
    for (const p of sessionPtys) {
      entries.push(await reconnectTerminal(p));
    }
    sessionTerminals.set(sid, {
      terminals: entries,
      activeTermIndex: 0,
      lastAccessed: Date.now(),
    });
  }

  // Restore the most recent alive session that has terminals
  const sessions = await window.api.getSessions();
  const lastActive = sessions.find(
    (s) => s.alive && sessionTerminals.has(s.sessionId),
  );
  if (lastActive) {
    currentSessionId = lastActive.sessionId;
    currentSessionCwd = lastActive.cwd;

    terminals = sessionTerminals.get(lastActive.sessionId).terminals;
    activeTermIndex = 0;

    emptyState.classList.add("hidden");
    sessionView.classList.remove("hidden");
    editorPane.classList.remove("hidden");
    editorProject.textContent = lastActive.project
      ? `${lastActive.project} — ${displayPath(lastActive)}`
      : lastActive.sessionId;

    const content = await window.api.readIntention(lastActive.sessionId);
    createEditor(content);
    await window.api.watchIntention(lastActive.sessionId);

    renderTerminalTabs();
    switchToTerminal(0);
  }
}

refreshBtn.addEventListener("click", async () => {
  await loadDirColors();
  loadSessions();
});

// --- Slot Terminal Popup (interactive) ---
async function openSlotTerminalPopup(slot) {
  // Don't open popup for dead/unknown slots — no terminal to attach to
  const status = slot.healthStatus || slot.status;
  if (status === "dead" || !slot.termId) {
    showNotification("Cannot open terminal for dead slot");
    return;
  }

  // Close existing popup if any (run its cleanup)
  const existingPopup = document.getElementById("slot-terminal-popup");
  if (existingPopup && existingPopup._cleanup) existingPopup._cleanup();
  else if (existingPopup) existingPopup.remove();

  const overlay = document.createElement("div");
  overlay.id = "slot-terminal-popup";
  overlay.className = "offload-menu-overlay";

  const label =
    slot.intentionHeading ||
    slot.sessionId?.slice(0, 8) ||
    `slot-${slot.index}`;

  overlay.innerHTML = `
    <div class="slot-terminal-dialog">
      <div class="slot-terminal-header">
        <span class="slot-terminal-title">${label}</span>
        <button class="snapshot-close slot-terminal-close">\u2715</button>
      </div>
      <div class="slot-terminal-mount"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const mountEl = overlay.querySelector(".slot-terminal-mount");
  const closeBtn = overlay.querySelector(".slot-terminal-close");

  const term = createTerminal();

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(mountEl);

  // Wire input to the PTY so the popup is interactive
  term.onData((data) => window.api.ptyWrite(slot.termId, data));

  // Register in popupTerminals so global data handlers can route data here.
  // Data is forwarded to both the main terminal entry (if any) and the popup entry.
  const popupEntry = { termId: slot.termId, term, fitAddon };
  popupTerminals.set(slot.termId, popupEntry);

  try {
    await window.api.ptyAttach(slot.termId);
  } catch (err) {
    showNotification(`Failed to attach: ${err.message}`);
    popupTerminals.delete(slot.termId);
    term.dispose();
    overlay.remove();
    return;
  }

  // Fit after a frame so dimensions are correct
  requestAnimationFrame(() => {
    fitAddon.fit();
    window.api.ptyResize(slot.termId, term.cols, term.rows);
  });

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    window.api.ptyResize(slot.termId, term.cols, term.rows);
  });
  resizeObserver.observe(mountEl);

  // Cleanup function — also stored on overlay for programmatic close
  const cleanup = () => {
    resizeObserver.disconnect();
    popupTerminals.delete(slot.termId);
    // Only detach if there's no other terminal entry still using this termId
    // (i.e. the session might be open in the main view)
    const otherEntry = findTerminalEntry(slot.termId);
    if (otherEntry) {
      // Restore PTY size to the main tab's dimensions
      window.api.ptyResize(
        slot.termId,
        otherEntry.term.cols,
        otherEntry.term.rows,
      );
    } else {
      window.api.ptyDetach(slot.termId).catch(() => {});
    }
    term.dispose();
    overlay.remove();
  };
  overlay._cleanup = cleanup;

  closeBtn.addEventListener("click", cleanup);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cleanup();
  });
}

// --- Pool Health Badge ---
const poolSettingsBtn = document.getElementById("pool-settings-btn");
let poolSettingsInterval = null;

// Show a warning dot on the ⚙ button when pool has error slots
async function updatePoolHealthBadge() {
  const pool = await window.api.poolRead();
  const errors = pool
    ? pool.slots.filter((s) => s.status === "error").length
    : 0;
  poolSettingsBtn.dataset.errors = errors;
  poolSettingsBtn.title =
    errors > 0
      ? `Pool settings — ${errors} slot${errors > 1 ? "s" : ""} in error`
      : "Pool settings";
}

poolSettingsBtn.addEventListener("click", () => showPoolSettings());

function stopPoolSettingsPolling() {
  if (poolSettingsInterval) {
    clearInterval(poolSettingsInterval);
    poolSettingsInterval = null;
  }
}

function poolStatusDot(status) {
  const cls = STATUS_CLASSES[status] || "dead";
  return `<span class="session-status ${cls}" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span>`;
}

function renderPoolSlotsHtml(health) {
  if (!health.initialized) return "";
  return health.slots
    .map((slot) => {
      const status = slot.healthStatus || slot.status;
      const label =
        slot.intentionHeading ||
        slot.sessionId?.slice(0, 8) ||
        `slot-${slot.index}`;
      return `<div class="pool-slot-row pool-slot-clickable" data-slot-index="${slot.index}">
        ${poolStatusDot(status)}
        <span class="pool-slot-label">${label}</span>
        <span class="pool-slot-status">${status}</span>
      </div>`;
    })
    .join("");
}

function renderPoolCountsHtml(health) {
  if (!health.initialized) return "Pool not initialized";
  return Object.entries(health.counts)
    .map(([k, v]) => `${poolStatusDot(k)} ${k}: ${v}`)
    .join("&nbsp;&nbsp;&nbsp;");
}

function closePoolSettings(overlay) {
  stopPoolSettingsPolling();
  overlay.remove();
}

async function showPoolSettings() {
  stopPoolSettingsPolling();
  const existing = document.getElementById("pool-settings");
  if (existing) existing.remove();

  const health = await window.api.poolHealth();

  const overlay = document.createElement("div");
  overlay.id = "pool-settings";
  overlay.className = "offload-menu-overlay";

  const slotsHtml = renderPoolSlotsHtml(health);
  const countsHtml = renderPoolCountsHtml(health);

  overlay.innerHTML = `
    <div class="pool-settings-dialog">
      <div class="pool-settings-header">
        <span>Pool Settings</span>
        <button class="snapshot-close pool-close">\u2715</button>
      </div>
      <div class="pool-settings-body">
        <div class="pool-health-summary">${countsHtml}</div>
        ${
          health.initialized
            ? `
          <div class="pool-slots-list">${slotsHtml}</div>
          <div class="pool-controls">
            <label class="pool-size-label">
              Pool size:
              <input type="number" class="pool-size-input" value="${health.poolSize}" min="1" max="20">
            </label>
            <button class="offload-menu-btn pool-resize-btn">Resize</button>
            <button class="offload-menu-btn pool-reload-btn">Reload Sessions</button>
            <button class="offload-menu-btn pool-clean-btn">Clean Idle</button>
            <button class="offload-menu-btn pool-destroy-btn">Destroy</button>
            <button class="offload-menu-btn pool-reinit-btn">Reinitialize</button>
          </div>
        `
            : `
          <div class="pool-controls">
            <label class="pool-size-label">
              Pool size:
              <input type="number" class="pool-size-input" value="5" min="1" max="20">
            </label>
            <button class="offload-menu-btn offload-menu-load pool-init-btn">Initialize Pool</button>
          </div>
        `
        }
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePoolSettings(overlay);
  });
  overlay
    .querySelector(".pool-close")
    .addEventListener("click", () => closePoolSettings(overlay));

  // Poll for health updates while dialog is open
  poolSettingsInterval = setInterval(async () => {
    // Stop polling if dialog was removed externally
    if (!document.getElementById("pool-settings")) {
      stopPoolSettingsPolling();
      return;
    }
    try {
      const h = await window.api.poolHealth();
      const summaryEl = overlay.querySelector(".pool-health-summary");
      if (summaryEl) summaryEl.innerHTML = renderPoolCountsHtml(h);
      const slotsEl = overlay.querySelector(".pool-slots-list");
      if (slotsEl) slotsEl.innerHTML = renderPoolSlotsHtml(h);
    } catch {
      // Ignore transient errors — next poll will retry
    }
  }, 3000);

  // Slot row click → open terminal popup (delegated to survive innerHTML poll updates)
  const slotsListEl = overlay.querySelector(".pool-slots-list");
  if (slotsListEl) {
    slotsListEl.addEventListener("click", async (e) => {
      const row = e.target.closest(".pool-slot-clickable");
      if (!row) return;
      const slotIndex = parseInt(row.dataset.slotIndex, 10);
      const currentHealth = await window.api.poolHealth();
      const slot = currentHealth.slots.find((s) => s.index === slotIndex);
      if (slot) openSlotTerminalPopup(slot);
    });
  }

  // Init button
  const initBtn = overlay.querySelector(".pool-init-btn");
  if (initBtn) {
    initBtn.addEventListener("click", async () => {
      const size = parseInt(
        overlay.querySelector(".pool-size-input").value,
        10,
      );
      if (isNaN(size) || size < 1 || size > 20) {
        showNotification("Pool size must be between 1 and 20");
        return;
      }
      initBtn.textContent = "Initializing...";
      initBtn.disabled = true;
      try {
        await window.api.poolInit(size);
        showNotification(`Pool initialized (${size} slots)`);
        await loadSessions();
        showPoolSettings();
      } catch (err) {
        initBtn.textContent = "Initialize Pool";
        initBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Resize button
  const resizeBtn = overlay.querySelector(".pool-resize-btn");
  if (resizeBtn) {
    resizeBtn.addEventListener("click", async () => {
      const newSize = parseInt(
        overlay.querySelector(".pool-size-input").value,
        10,
      );
      if (isNaN(newSize) || newSize < 1 || newSize > 20) {
        showNotification("Pool size must be between 1 and 20");
        return;
      }
      resizeBtn.textContent = "Resizing...";
      resizeBtn.disabled = true;
      try {
        await window.api.poolResize(newSize);
        showNotification(`Pool resized to ${newSize} slots`);
        await loadSessions();
        showPoolSettings();
      } catch (err) {
        resizeBtn.textContent = "Resize";
        resizeBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Reload button
  const reloadBtn = overlay.querySelector(".pool-reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", async () => {
      closePoolSettings(overlay);
      await loadDirColors();
      await loadSessions();
      showNotification("Sessions reloaded");
    });
  }

  // Clean idle button
  const cleanBtn = overlay.querySelector(".pool-clean-btn");
  if (cleanBtn) {
    cleanBtn.addEventListener("click", async () => {
      cleanBtn.textContent = "Cleaning...";
      cleanBtn.disabled = true;
      try {
        const cleaned = await window.api.poolClean();
        showNotification(
          `Cleaned ${cleaned} idle session${cleaned !== 1 ? "s" : ""}`,
        );
        await loadSessions();
        showPoolSettings();
      } catch (err) {
        cleanBtn.textContent = "Clean Idle";
        cleanBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Destroy button
  const destroyBtn = overlay.querySelector(".pool-destroy-btn");
  if (destroyBtn) {
    destroyBtn.addEventListener("click", async () => {
      destroyBtn.textContent = "Destroying...";
      destroyBtn.disabled = true;
      try {
        await window.api.poolDestroy();
        showNotification("Pool destroyed");
        await loadSessions();
        showPoolSettings();
      } catch (err) {
        destroyBtn.textContent = "Destroy";
        destroyBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Reinitialize button (destroy + init)
  const reinitBtn = overlay.querySelector(".pool-reinit-btn");
  if (reinitBtn) {
    reinitBtn.addEventListener("click", async () => {
      const size = parseInt(
        overlay.querySelector(".pool-size-input").value,
        10,
      );
      if (isNaN(size) || size < 1 || size > 20) {
        showNotification("Pool size must be between 1 and 20");
        return;
      }
      reinitBtn.textContent = "Reinitializing...";
      reinitBtn.disabled = true;
      try {
        await window.api.poolDestroy();
      } catch (err) {
        reinitBtn.textContent = "Reinitialize";
        reinitBtn.disabled = false;
        showNotification(`Destroy failed: ${err.message}`);
        return;
      }
      try {
        await window.api.poolInit(size);
        showNotification(`Pool reinitialized (${size} slots)`);
      } catch (err) {
        showNotification(`Pool destroyed but re-init failed: ${err.message}`);
      }
      await loadSessions();
      showPoolSettings();
    });
  }
}

// Add pool settings to command palette
COMMANDS.push({
  id: "pool-settings",
  label: "Pool Settings",
  action: () => showPoolSettings(),
});

// --- Shortcut Settings UI ---
// Build labels from COMMANDS entries (avoids duplicating labels)
const SHORTCUT_LABELS = {};
for (const cmd of COMMANDS) {
  if (cmd.shortcutAction) SHORTCUT_LABELS[cmd.shortcutAction] = cmd.label;
}
// Actions only reachable via input events (no COMMANDS entry)
SHORTCUT_LABELS["next-terminal-tab-alt"] = "Next Tab (Alt)";
SHORTCUT_LABELS["prev-terminal-tab-alt"] = "Previous Tab (Alt)";

async function showShortcutSettings() {
  const existing = document.getElementById("shortcut-settings");
  if (existing) existing.remove();

  const shortcuts = await window.api.getShortcuts();
  shortcutConfig = shortcuts;

  // Track active keydown listener for cleanup
  let activeKeyHandler = null;

  function cleanupRecording() {
    if (activeKeyHandler) {
      document.removeEventListener("keydown", activeKeyHandler, true);
      activeKeyHandler = null;
    }
  }

  const overlay = document.createElement("div");
  overlay.id = "shortcut-settings";
  overlay.className = "offload-menu-overlay";

  const actionIds = Object.keys(SHORTCUT_LABELS);
  const rows = actionIds
    .map((id) => {
      const label = SHORTCUT_LABELS[id];
      const current = shortcuts[id] || "";
      const display = formatShortcutDisplay(current) || "—";
      return `<div class="shortcut-row" data-action="${id}">
        <span class="shortcut-label">${label}</span>
        <button class="shortcut-key-btn" title="Click to rebind">${display}</button>
        <button class="shortcut-reset-btn" title="Reset to default">↺</button>
      </div>`;
    })
    .join("");

  overlay.innerHTML = `
    <div class="shortcut-settings-dialog">
      <div class="pool-settings-header">
        <span>Keyboard Shortcuts</span>
        <button class="close-dialog-btn">✕</button>
      </div>
      <div class="shortcut-settings-body">
        ${rows}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  function closeDialog() {
    cleanupRecording();
    overlay.remove();
  }

  // Close on overlay click or close button
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay
    .querySelector(".close-dialog-btn")
    .addEventListener("click", closeDialog);

  // Rebind: click key button → enter recording mode
  overlay.querySelectorAll(".shortcut-key-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Cancel any existing recording
      cleanupRecording();
      const existingBtn = overlay.querySelector(".shortcut-key-btn.recording");
      if (existingBtn && existingBtn !== btn) {
        existingBtn.classList.remove("recording");
        const oldAction = existingBtn.closest(".shortcut-row").dataset.action;
        existingBtn.textContent =
          formatShortcutDisplay(shortcuts[oldAction]) || "\u2014";
      }

      btn.classList.add("recording");
      btn.textContent = "Press keys...";

      function onKeyDown(e) {
        e.preventDefault();
        e.stopPropagation();

        // Ignore lone modifier keys
        if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;

        // Escape cancels recording
        if (e.key === "Escape") {
          btn.classList.remove("recording");
          const actionId = btn.closest(".shortcut-row").dataset.action;
          btn.textContent =
            formatShortcutDisplay(shortcuts[actionId]) || "\u2014";
          cleanupRecording();
          return;
        }

        // Build Electron accelerator from the event
        const parts = [];
        if (e.metaKey) parts.push("CmdOrCtrl");
        if (e.ctrlKey && !e.metaKey) parts.push("Ctrl");
        if (e.shiftKey) parts.push("Shift");
        if (e.altKey) parts.push("Alt");

        const keyMap = {
          ArrowUp: "Up",
          ArrowDown: "Down",
          ArrowLeft: "Left",
          ArrowRight: "Right",
          " ": "Space",
          Backspace: "Backspace",
          Delete: "Delete",
          Enter: "Return",
          Tab: "Tab",
        };
        const key = keyMap[e.key] || e.key.toUpperCase();
        parts.push(key);

        const accelerator = parts.join("+");
        const actionId = btn.closest(".shortcut-row").dataset.action;

        btn.classList.remove("recording");
        btn.textContent = formatShortcutDisplay(accelerator);
        shortcuts[actionId] = accelerator;
        shortcutConfig = { ...shortcuts };

        window.api.setShortcut(actionId, accelerator);
        cleanupRecording();
      }

      activeKeyHandler = onKeyDown;
      document.addEventListener("keydown", onKeyDown, true);
    });
  });

  // Reset buttons
  overlay.querySelectorAll(".shortcut-reset-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".shortcut-row");
      const actionId = row.dataset.action;
      await window.api.resetShortcut(actionId);
      const defaultVal = await window.api.getDefaultShortcut(actionId);
      shortcuts[actionId] = defaultVal;
      shortcutConfig = { ...shortcuts };
      const keyBtn = row.querySelector(".shortcut-key-btn");
      keyBtn.textContent = formatShortcutDisplay(defaultVal) || "—";
    });
  });

  // Unbind: button to clear a shortcut
  overlay.querySelectorAll(".shortcut-key-btn").forEach((btn) => {
    btn.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const row = btn.closest(".shortcut-row");
      const actionId = row.dataset.action;
      await window.api.setShortcut(actionId, "");
      shortcuts[actionId] = "";
      shortcutConfig = { ...shortcuts };
      btn.textContent = "—";
    });
  });
}

// Add shortcut settings to command palette
COMMANDS.push({
  id: "shortcut-settings",
  label: "Keyboard Shortcuts",
  action: () => showShortcutSettings(),
});

loadDirColors().then(async () => {
  // Load shortcut config for command palette display
  try {
    shortcutConfig = await window.api.getShortcuts();
  } catch {}

  await reconnectAllPtys();
  const POLL_INTERVAL = 30000; // Safety net — events handle normal refresh
  let sessionPollInterval = setInterval(loadSessions, POLL_INTERVAL);
  loadSessions();

  // Event-driven refresh: main process pushes (already debounced) when
  // idle-signals/session-pids change. Reset poll timer on each event since
  // polling only needs to kick in when events stop working.
  window.api.onSessionsChanged(() => {
    loadSessions();
    clearInterval(sessionPollInterval);
    sessionPollInterval = setInterval(loadSessions, POLL_INTERVAL);
  });

  // Pause polling when window is hidden to save CPU
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(sessionPollInterval);
      sessionPollInterval = null;
    } else {
      if (!sessionPollInterval) {
        loadSessions();
        sessionPollInterval = setInterval(loadSessions, POLL_INTERVAL);
      }
    }
  });
});
