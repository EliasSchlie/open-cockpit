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
    color: "#89b4fa",
    marginTop: "8px",
  },
  ".cm-md-heading2": {
    fontSize: "1.4em",
    fontWeight: "600",
    color: "#89b4fa",
    marginTop: "6px",
  },
  ".cm-md-heading3": {
    fontSize: "1.2em",
    fontWeight: "600",
    color: "#89b4fa",
    marginTop: "4px",
  },
  ".cm-md-bold": { fontWeight: "700" },
  ".cm-md-italic": { fontStyle: "italic" },
  ".cm-md-code": {
    fontFamily: "'SF Mono', Menlo, monospace",
    fontSize: "13px",
    background: "#313244",
    padding: "1px 5px",
    borderRadius: "3px",
  },
  ".cm-md-link": { color: "#89b4fa", textDecoration: "underline" },
  ".cm-md-strikethrough": { textDecoration: "line-through", color: "#6c7086" },
  ".cm-md-bullet-char": {
    color: "#89b4fa",
    fontWeight: "600",
    marginRight: "2px",
  },
  ".cm-md-list-line": { paddingLeft: "8px" },
  ".cm-md-blockquote": {
    borderLeft: "3px solid #89b4fa",
    paddingLeft: "14px",
    color: "#a6adc8",
  },
  ".cm-md-hr": {
    display: "block",
    borderTop: "1px solid #45475a",
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
      backgroundColor: "#1e1e2e",
      color: "#cdd6f4",
      height: "100%",
    },
    ".cm-cursor": { borderLeftColor: "#cdd6f4" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#45475a",
    },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine": { backgroundColor: "#25253a" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { overflow: "auto" },
  },
  { dark: true },
);

// --- xterm.js Catppuccin theme ---
const TERM_THEME = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#cdd6f4",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#45475a",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

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

// Terminal state: multiple terminals per session
const terminals = [];
let activeTermIndex = -1;

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

function killAllTerminals() {
  const kills = [];
  while (terminals.length > 0) {
    const entry = terminals.pop();
    kills.push(window.api.ptyKill(entry.termId).catch(() => {}));
    entry.resizeObserver.disconnect();
    entry.term.dispose();
    entry.container.remove();
  }
  activeTermIndex = -1;
  terminalTabList.innerHTML = "";
  return Promise.all(kills);
}

// Wire PTY output from main process
window.api.onPtyData((termId, data) => {
  const entry = terminals.find((t) => t.termId === termId);
  if (entry) entry.term.write(data);
});

window.api.onPtyExit((termId) => {
  const entry = terminals.find((t) => t.termId === termId);
  if (entry) entry.term.write("\r\n[Process exited]\r\n");
});

async function loadSessions() {
  const sessions = await window.api.getSessions();
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
    li.innerHTML = `
      <div class="session-project">
        <span class="session-status ${s.alive ? "alive" : "dead"}"></span>
        ${heading}
      </div>
      <div class="session-cwd">${displayPath}</div>
    `;
    li.addEventListener("click", () => selectSession(s));
    sessionList.appendChild(li);
  }
}

async function selectSession(session) {
  currentSessionId = session.sessionId;
  currentSessionCwd = session.cwd;

  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.sessionId === session.sessionId);
  });

  killAllTerminals();

  emptyState.classList.add("hidden");
  sessionView.classList.remove("hidden");
  editorPane.classList.remove("hidden");
  editorProject.textContent = session.project
    ? `${session.project} — ${session.cwd.replace(session.home, "~")}`
    : session.sessionId;

  const content = await window.api.readIntention(session.sessionId);
  createEditor(content);
  saveStatus.textContent = "";

  await window.api.watchIntention(session.sessionId);

  // Open a companion shell at session's CWD
  await spawnTerminal(session.cwd);
}

// "+" in sidebar: new Claude session
newSessionBtn.addEventListener("click", async () => {
  // Snapshot current session IDs to detect the new one
  const beforeSessions = await window.api.getSessions();
  const beforeIds = new Set(beforeSessions.map((s) => s.sessionId));

  currentSessionId = null;
  currentSessionCwd = null;

  document
    .querySelectorAll(".session-item")
    .forEach((el) => el.classList.remove("active"));

  killAllTerminals();

  emptyState.classList.add("hidden");
  sessionView.classList.remove("hidden");
  editorPane.classList.add("hidden"); // hide editor until session detected

  // Spawn Claude via interactive shell (resolves `c` alias)
  await spawnTerminal(null, "/bin/zsh", ["-ic", "c"]);

  // Poll for a new session to appear
  let attempts = 0;
  const detectSession = async () => {
    const sessions = await window.api.getSessions();
    const newSession = sessions.find((s) => !beforeIds.has(s.sessionId));
    if (newSession) {
      currentSessionId = newSession.sessionId;
      currentSessionCwd = newSession.cwd;
      editorPane.classList.remove("hidden");
      editorProject.textContent = newSession.project
        ? `${newSession.project} — ${newSession.cwd.replace(newSession.home, "~")}`
        : "New session";

      const content = await window.api.readIntention(newSession.sessionId);
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

refreshBtn.addEventListener("click", loadSessions);
setInterval(loadSessions, 10000);
loadSessions();
