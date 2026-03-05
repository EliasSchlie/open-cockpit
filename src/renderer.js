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
    ".cm-cursor": { borderLeftColor: "#ff1a1a" },
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
  cursor: "#ff1a1a",
  cursorAccent: "#0a0a0a",
  selectionBackground: "rgba(255, 26, 26, 0.25)",
  selectionForeground: "#ffffff",
};

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

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
  });

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

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
  });

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

  // Split into sections — pool and external mixed together
  const recent = sessions.filter(
    (s) => s.status === "idle" || s.status === "offloaded",
  );
  const processing = sessions.filter((s) => s.status === "processing");
  const archived = sessions.filter((s) => s.status === "archived");

  // Build fingerprint to check if anything changed
  const allItems = [...recent, ...processing, ...archived];
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

  if (recent.length === 0 && processing.length === 0 && archived.length === 0) {
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
  const originTag = s.origin
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
  li.addEventListener("click", () => handleSessionClick(s));
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

// Handle click differently for offloaded/archived vs loaded sessions
async function handleSessionClick(session) {
  if (session.status === "archived" || session.status === "offloaded") {
    showSessionResumeMenu(session);
  } else {
    selectSession(session);
  }
}

// Show resume/restart menu for offloaded or archived sessions
async function showSessionResumeMenu(session) {
  const existing = document.getElementById("offload-menu");
  if (existing) existing.remove();

  const isArchived = session.status === "archived";
  const loadLabel = isArchived ? "Restart Session" : "Load Session";
  const fallbackTitle = isArchived ? "Archived Session" : "Offloaded Session";

  const menu = document.createElement("div");
  menu.id = "offload-menu";
  menu.className = "offload-menu-overlay";
  menu.innerHTML = `
    <div class="offload-menu-dialog">
      <div class="offload-menu-title">${escapeHtml(session.intentionHeading || fallbackTitle)}</div>
      <div class="offload-menu-subtitle">${escapeHtml(displayPath(session))}</div>
      <div class="offload-menu-actions">
        <button class="offload-menu-btn offload-menu-load">${loadLabel}</button>
        ${session.hasSnapshot ? '<button class="offload-menu-btn offload-menu-snapshot">View Snapshot</button>' : ""}
        <button class="offload-menu-btn offload-menu-cancel">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(menu);

  menu.addEventListener("click", (e) => {
    if (e.target === menu) menu.remove();
  });

  menu.querySelector(".offload-menu-cancel").addEventListener("click", () => {
    menu.remove();
  });

  const snapshotBtn = menu.querySelector(".offload-menu-snapshot");
  if (snapshotBtn) {
    snapshotBtn.addEventListener("click", async () => {
      menu.remove();
      let snapshot;
      try {
        snapshot = await window.api.readOffloadSnapshot(session.sessionId);
      } catch (err) {
        console.error("Failed to read offload snapshot:", err);
        snapshot = null;
      }
      showSnapshotViewer(session, snapshot);
    });
  }

  menu
    .querySelector(".offload-menu-load")
    .addEventListener("click", async () => {
      menu.remove();
      if (isArchived) {
        try {
          await window.api.unarchiveSession(session.sessionId);
        } catch (err) {
          console.error("Failed to unarchive session:", err);
        }
      }
      await resumeOffloadedSession(session);
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

function displayPath(session) {
  return session.cwd ? session.cwd.replace(session.home, "~") : "~";
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Acquire a fresh slot: prefer existing fresh, else offload LRU idle.
// Returns the fresh session object or null if pool is fully busy.
async function acquireFreshSlot() {
  const sessions = await window.api.getSessions();
  const pool = await window.api.poolRead();
  if (!pool) return null;

  // Build set of pool-fresh sessionIds (pool says "fresh" even if getSessions says "processing")
  const poolFreshIds = new Set(
    pool.slots
      .filter((s) => s.status === "fresh" && s.sessionId)
      .map((s) => s.sessionId),
  );

  // 1. Prefer an existing fresh slot (by session status or pool status)
  const freshSession = sessions.find(
    (s) => s.status === "fresh" || poolFreshIds.has(s.sessionId),
  );
  if (freshSession) return freshSession;

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

  // Find the victim's terminal (from pool, not from renderer cache)
  const victimSlot = pool.slots.find((s) => s.sessionId === victim.sessionId);
  if (!victimSlot) return null;

  try {
    await window.api.offloadSession(
      victim.sessionId,
      victimSlot.termId,
      victim.sessionId, // Claude session UUID = our session ID (same value from hook)
      { cwd: victim.cwd, gitRoot: victim.gitRoot, pid: victim.pid },
    );
  } catch (err) {
    console.error("Failed to offload session:", err);
    return null;
  }

  // Poll until the slot becomes fresh (idle signal changes after /clear)
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
    const pool = await window.api.poolRead();
    const poolFreshIds = new Set(
      (pool?.slots || [])
        .filter((s) => s.status === "fresh" && s.sessionId)
        .map((s) => s.sessionId),
    );
    const fresh = sessions.find(
      (s) => s.status === "fresh" || poolFreshIds.has(s.sessionId),
    );
    if (fresh) return fresh;
  }
  return null;
}

// Resume an offloaded session into a fresh slot
async function resumeOffloadedSession(session) {
  try {
    const result = await window.api.poolResume(session.sessionId);
    showNotification(`Resuming session in slot ${result.slotIndex}…`);
  } catch (err) {
    showNotification(`Resume failed: ${err.message}`);
    return;
  }
  await loadSessions();
}

function showNotification(msg) {
  saveStatus.textContent = msg;
  setTimeout(() => {
    if (saveStatus.textContent === msg) saveStatus.textContent = "";
  }, 3000);
}

async function selectSession(session) {
  // If already viewing this session, re-focus its external terminal (if any)
  if (session.sessionId === currentSessionId) {
    if (session.alive) {
      const result = await window.api.focusExternalTerminal(session.pid);
      if (result.focused) {
        saveStatus.textContent = `Focused ${result.app}`;
        setTimeout(() => {
          if (saveStatus.textContent === `Focused ${result.app}`)
            saveStatus.textContent = "";
        }, 2000);
      }
    }
    return;
  }

  hideCurrentTerminals();

  currentSessionId = session.sessionId;
  currentSessionCwd = session.cwd;
  const gen = ++sessionGeneration;

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

  // External sessions: try to focus their terminal app (iTerm/Cursor)
  if (session.origin !== "pool" && session.alive) {
    const result = await window.api.focusExternalTerminal(session.pid);
    if (gen !== sessionGeneration) return;
    if (result.focused) {
      saveStatus.textContent = `Focused ${result.app}`;
      setTimeout(() => {
        if (saveStatus.textContent === `Focused ${result.app}`)
          saveStatus.textContent = "";
      }, 2000);
    }
  }

  // Restore cached terminals immediately (sync, no race risk)
  if (!restoreSessionTerminals(session.sessionId)) {
    if (session.origin === "pool") {
      // Pool session: attach to the pool slot's existing Claude TUI
      const pool = await window.api.poolRead();
      if (gen !== sessionGeneration) return;
      const slot = pool?.slots.find((s) => s.sessionId === session.sessionId);
      if (slot) {
        try {
          const entry = await attachPoolTerminal(slot.termId);
          if (gen !== sessionGeneration) {
            // Session changed while attaching — detach and clean up
            // Also purge from sessionTerminals (hideCurrentTerminals may have cached it)
            destroySessionTerminals(session.sessionId);
            return;
          }
        } catch {
          // Attach failed (slot dead?) — fall back to fresh shell
          const entry = await spawnTerminal(session.cwd);
          if (gen !== sessionGeneration) {
            destroySessionTerminals(session.sessionId);
            return;
          }
        }
      } else {
        // No pool slot found — fall back to fresh shell
        const entry = await spawnTerminal(session.cwd);
        if (gen !== sessionGeneration) {
          destroySessionTerminals(session.sessionId);
          return;
        }
      }
    } else {
      // External session: spawn a fresh shell
      const entry = await spawnTerminal(session.cwd);
      if (gen !== sessionGeneration) {
        // Session changed while spawning — orphan cleanup
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

  // Check if pool is still initializing (has starting/unresolved slots)
  const health = await window.api.poolHealth();
  if (health?.counts?.starting > 0) {
    showNotification("Pool still initializing — wait for slots to be ready");
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
      console.error("Failed to save intention:", err);
      saveStatus.textContent = "";
    }
  }, 500);
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
  // Navigate between loaded sessions (idle + processing, pool + external), skip offloaded/fresh/dead
  const navigable = cachedSessions.filter(
    (s) => s.alive && (s.status === "idle" || s.status === "processing"),
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

// --- Archive current session (then jump to recent idle) ---
async function archiveCurrentSession() {
  if (!currentSessionId) return;
  const session = cachedSessions.find((s) => s.sessionId === currentSessionId);
  if (!session) return;
  // Can't archive already-archived sessions
  if (session.status === "archived") return;

  try {
    await window.api.archiveSession(currentSessionId);
  } catch (err) {
    console.error("Failed to archive session:", err);
  }
  await loadSessions();
  // Jump to the most recent idle session
  const idle = cachedSessions.find((s) => s.status === "idle");
  if (idle) {
    selectSession(idle);
  }
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
const COMMANDS = [
  {
    id: "next-session",
    label: "Next Session",
    shortcut: "Alt+↓",
    action: () => switchSession(1),
  },
  {
    id: "prev-session",
    label: "Previous Session",
    shortcut: "Alt+↑",
    action: () => switchSession(-1),
  },
  {
    id: "new-session",
    label: "New Claude Session",
    shortcut: "⌘N",
    action: () => newSessionBtn.click(),
  },
  {
    id: "new-terminal",
    label: "New Terminal Tab",
    shortcut: "⌘T",
    action: () => {
      if (currentSessionId) spawnTerminal(currentSessionCwd);
    },
  },
  {
    id: "close-terminal",
    label: "Close Terminal Tab",
    shortcut: "⌘W",
    action: () => {
      if (activeTermIndex >= 0) closeTerminal(activeTermIndex);
    },
  },
  {
    id: "next-tab",
    label: "Next Terminal Tab",
    shortcut: "⌘⇧]",
    action: () => {
      if (terminals.length > 1)
        switchToTerminal((activeTermIndex + 1) % terminals.length);
    },
  },
  {
    id: "prev-tab",
    label: "Previous Terminal Tab",
    shortcut: "⌘⇧[",
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
    shortcut: "⌘J",
    action: jumpToRecentIdle,
  },
  {
    id: "archive-current-session",
    label: "Archive Current Session",
    shortcut: "⌘D",
    action: archiveCurrentSession,
  },
  {
    id: "toggle-sidebar",
    label: "Toggle Sidebar",
    shortcut: "⌘\\",
    action: toggleSidebar,
  },
  {
    id: "focus-editor",
    label: "Focus Editor",
    shortcut: "⌘E",
    action: focusEditor,
  },
  {
    id: "focus-terminal",
    label: "Focus Terminal",
    shortcut: "⌘`",
    action: focusTerminal,
  },
  {
    id: "toggle-pane-focus",
    label: "Toggle Pane Focus",
    shortcut: "Alt+←/→",
    action: () => {
      if (editorMount.contains(document.activeElement)) {
        focusTerminal();
      } else {
        focusEditor();
      }
    },
  },
  {
    id: "refresh",
    label: "Refresh Sessions",
    shortcut: "",
    action: () => {
      loadDirColors();
      loadSessions();
    },
  },
  {
    id: "command-palette",
    label: "Command Palette",
    shortcut: "⌘/",
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

function renderPaletteList(query) {
  const q = query.toLowerCase();
  filteredCommands = q
    ? COMMANDS.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          c.shortcut.toLowerCase().includes(q),
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
    item.innerHTML = `<span class="command-palette-label">${cmd.label}</span><span class="command-palette-shortcut">${cmd.shortcut}</span>`;
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
window.api.onJumpRecentIdle(jumpToRecentIdle);
window.api.onArchiveCurrentSession(archiveCurrentSession);

// Reconnect a single PTY from daemon (after app restart or reload)
async function reconnectTerminal(ptyInfo) {
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;display:none;";
  terminalMount.appendChild(container);

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    // Match the PTY's current dimensions so replay buffer renders correctly
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
      // Detach orphaned terminals — they have no session to display under
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

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
  });

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

// --- Pool Settings Panel ---
const poolSettingsBtn = document.getElementById("pool-settings-btn");
let poolSettingsInterval = null;

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
  shortcut: "",
  action: () => showPoolSettings(),
});

loadDirColors().then(async () => {
  await reconnectAllPtys();
  const POLL_INTERVAL = 5000;
  let sessionPollInterval = setInterval(loadSessions, POLL_INTERVAL);
  loadSessions();

  // Event-driven refresh: main process pushes (already debounced) when
  // idle-signals/session-pids change.
  window.api.onSessionsChanged(() => loadSessions());

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
