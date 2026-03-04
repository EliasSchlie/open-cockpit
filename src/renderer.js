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
    background: "#1a1a1a",
    padding: "1px 5px",
    borderRadius: "3px",
    color: "#ff6666",
  },
  ".cm-md-link": { color: "#ff4444", textDecoration: "underline" },
  ".cm-md-strikethrough": { textDecoration: "line-through", color: "#555555" },
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
    borderTop: "1px solid #1a1a1a",
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

  tree.iterate({
    enter(node) {
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
      if (node.name === "URL" && node.from < node.to) {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }

      const styleClass = INLINE_STYLES[node.name];
      if (styleClass && node.from < node.to) {
        decorations.push(
          Decoration.mark({ class: styleClass }).range(node.from, node.to),
        );
      }
      if (node.name === "Link" && node.from < node.to) {
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
      backgroundColor: "#1a0808",
    },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine": { backgroundColor: "#0f0f0f" },
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
  selectionBackground: "#1a0808",
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

// Sync current terminals into the session cache
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

  const { termId, pid } = await window.api.ptySpawn({
    cwd: cwd || undefined,
    cmd: cmd || undefined,
    args: args || undefined,
  });

  term.onData((data) => window.api.ptyWrite(termId, data));

  const resizeObserver = new ResizeObserver(() => {
    if (container.style.display !== "none") {
      fitAddon.fit();
      window.api.ptyResize(termId, term.cols, term.rows);
    }
  });
  resizeObserver.observe(terminalMount);

  const entry = { termId, pid, term, fitAddon, resizeObserver, container };
  terminals.push(entry);

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

  requestAnimationFrame(() => {
    terminals[index].fitAddon.fit();
    terminals[index].term.focus();
  });

  renderTerminalTabs();
}

async function closeTerminal(index) {
  if (index < 0 || index >= terminals.length) return;

  const entry = terminals[index];
  await window.api.ptyKill(entry.termId);
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
  terminals.forEach((t, i) => {
    const tab = document.createElement("button");
    tab.className = `terminal-tab${i === activeTermIndex ? " active" : ""}`;
    tab.textContent = `Terminal ${i + 1} `;
    const closeBtn = document.createElement("span");
    closeBtn.className = "terminal-tab-close";
    closeBtn.textContent = "\u2715";
    tab.appendChild(closeBtn);
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
    window.api.ptyKill(entry.termId).catch(() => {});
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
    window.api.ptyKill(entry.termId).catch(() => {});
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
function findTerminalEntry(termId) {
  const active = terminals.find((t) => t.termId === termId);
  if (active) return active;
  for (const cached of sessionTerminals.values()) {
    const entry = cached.terminals.find((t) => t.termId === termId);
    if (entry) return entry;
  }
  return null;
}

// Wire PTY output from main process
window.api.onPtyData((termId, data) => {
  const entry = findTerminalEntry(termId);
  if (entry) entry.term.write(data);
});

window.api.onPtyExit((termId) => {
  const entry = findTerminalEntry(termId);
  if (entry) entry.term.write("\r\n[Process exited]\r\n");
});

async function loadSessions() {
  const sessions = await window.api.getSessions();
  cleanupStaleTerminals(sessions);
  sessionList.innerHTML = "";

  if (sessions.length === 0) {
    sessionList.innerHTML =
      '<li style="padding: 12px; color: var(--text-dim); font-size: 13px;">No sessions found</li>';
    return;
  }

  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = `session-item${s.sessionId === currentSessionId ? " active" : ""}`;
    li.dataset.sessionId = s.sessionId;
    const heading = s.intentionHeading || "No intention yet";
    const displayPath = s.cwd ? s.cwd.replace(s.home, "~") : "~";
    const dirColor = getDirColor(s);
    const indicatorStyle = dirColor
      ? `background: ${dirColor}; box-shadow: 0 0 4px ${dirColor}`
      : "background: transparent";
    li.innerHTML = `
      <div class="session-dir-indicator" style="${indicatorStyle}"></div>
      <div class="session-item-content">
        <div class="session-project">
          <span class="session-status ${s.alive ? "alive" : "dead"}"></span>
          ${heading}
        </div>
        <div class="session-cwd">${displayPath}</div>
      </div>
    `;
    li.addEventListener("click", () => selectSession(s));
    sessionList.appendChild(li);
  }
}

async function selectSession(session) {
  // Skip if already viewing this session
  if (session.sessionId === currentSessionId) return;

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
    ? `${session.project} — ${session.cwd.replace(session.home, "~")}`
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

  // Restore cached terminals immediately (sync, no race risk)
  if (!restoreSessionTerminals(session.sessionId)) {
    // Spawn is async — guard against stale completion
    const entry = await spawnTerminal(session.cwd);
    if (gen !== sessionGeneration) {
      // Session changed while spawning — orphan cleanup
      await window.api.ptyKill(entry.termId);
      entry.resizeObserver.disconnect();
      entry.term.dispose();
      entry.container.remove();
      return;
    }
  }

  const content = await window.api.readIntention(session.sessionId);
  if (gen !== sessionGeneration) return;
  createEditor(content);
  saveStatus.textContent = "";

  await window.api.watchIntention(session.sessionId);
}

// "+" in sidebar: new Claude session
newSessionBtn.addEventListener("click", async () => {
  // Snapshot current session IDs to detect the new one
  const beforeSessions = await window.api.getSessions();
  const beforeIds = new Set(beforeSessions.map((s) => s.sessionId));

  // Save current session's terminals before switching
  hideCurrentTerminals();

  currentSessionId = null;
  currentSessionCwd = null;
  const gen = ++sessionGeneration;

  document
    .querySelectorAll(".session-item")
    .forEach((el) => el.classList.remove("active"));

  emptyState.classList.add("hidden");
  sessionView.classList.remove("hidden");
  editorPane.classList.add("hidden"); // hide editor until session detected

  // Spawn Claude via interactive shell (resolves `c` alias)
  await spawnTerminal(null, "/bin/zsh", ["-ic", "c"]);
  if (gen !== sessionGeneration) return;

  // Poll for a new session to appear
  let attempts = 0;
  const detectSession = async () => {
    if (gen !== sessionGeneration) return; // user switched away
    const sessions = await window.api.getSessions();
    const newSession = sessions.find((s) => !beforeIds.has(s.sessionId));
    if (newSession) {
      if (gen !== sessionGeneration) return;
      currentSessionId = newSession.sessionId;
      currentSessionCwd = newSession.cwd;
      syncSessionCache();

      editorPane.classList.remove("hidden");
      editorProject.textContent = newSession.project
        ? `${newSession.project} — ${newSession.cwd.replace(newSession.home, "~")}`
        : "New session";

      const content = await window.api.readIntention(newSession.sessionId);
      if (gen !== sessionGeneration) return;
      createEditor(content);
      saveStatus.textContent = "";
      await window.api.watchIntention(newSession.sessionId);
      await loadSessions();
    } else if (++attempts < 30) {
      setTimeout(detectSession, 1000);
    }
  };
  setTimeout(detectSession, 2000); // give Claude a moment to start
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
    await window.api.writeIntention(currentSessionId, content);
    saveStatus.textContent = "Saved";
    setTimeout(() => {
      if (saveStatus.textContent === "Saved") saveStatus.textContent = "";
    }, 2000);
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

// Menu keyboard shortcuts (Cmd+T, Cmd+W)
window.api.onNewTerminalTab(() => {
  if (currentSessionId) spawnTerminal(currentSessionCwd);
});

window.api.onCloseTerminalTab(() => {
  if (activeTermIndex >= 0) closeTerminal(activeTermIndex);
});

refreshBtn.addEventListener("click", async () => {
  await loadDirColors();
  loadSessions();
});
loadDirColors().then(() => {
  setInterval(loadSessions, 10000);
  loadSessions();
});
