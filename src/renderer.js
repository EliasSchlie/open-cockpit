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
  // Headings
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
  // Inline formatting
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
  // Bullet
  ".cm-md-bullet-char": {
    color: "#89b4fa",
    fontWeight: "600",
    marginRight: "2px",
  },
  ".cm-md-list-line": { paddingLeft: "8px" },
  // Blockquote
  ".cm-md-blockquote": {
    borderLeft: "3px solid #89b4fa",
    paddingLeft: "14px",
    color: "#a6adc8",
  },
  // Horizontal rule
  ".cm-md-hr": {
    display: "block",
    borderTop: "1px solid #45475a",
    margin: "12px 0",
  },
  // Checkbox
  ".cm-md-checkbox": { marginRight: "4px" },
});

const INLINE_STYLES = {
  StrongEmphasis: "cm-md-bold",
  Emphasis: "cm-md-italic",
  InlineCode: "cm-md-code",
  Strikethrough: "cm-md-strikethrough",
};

// Marks to hide on non-active lines
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
  const processedLines = new Set(); // track line decorations to avoid duplicates

  // Track ordered list numbering
  let orderedIndex = 0;

  tree.iterate({
    enter(node) {
      const line = state.doc.lineAt(node.from);
      const isActive = activeLines.has(line.number);

      // --- Headings (apply on all lines) ---
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
        if (isActive) return; // show raw markdown on active line
      }

      // On active lines: show raw markdown, skip decorations
      if (isActive) return;

      // --- Blockquote ---
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

      // --- List items: replace marker with bullet/number ---
      if (node.name === "ListMark") {
        const text = state.doc.sliceString(node.from, node.to);
        const isOrdered = /^\d+[.)]$/.test(text);

        if (isOrdered) {
          orderedIndex++;
        } else {
          orderedIndex = 0;
        }

        // Replace the list marker (and trailing space) with a widget
        let end = node.to;
        // Include trailing space after marker
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

        // Add indentation to the line
        if (!processedLines.has(`list-${line.number}`)) {
          decorations.push(
            Decoration.line({ class: "cm-md-list-line" }).range(line.from),
          );
          processedLines.add(`list-${line.number}`);
        }
        return;
      }

      // --- Hide syntax marks ---
      if (SYNTAX_MARKS.has(node.name) && node.from < node.to) {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }

      // --- Link marks (hide [ ] ( ) on non-active lines) ---
      if (node.name === "LinkMark" && node.from < node.to) {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }

      // --- URL in links (hide on non-active lines) ---
      if (node.name === "URL" && node.from < node.to) {
        // Hide the URL portion including surrounding parens
        decorations.push(Decoration.replace({}).range(node.from, node.to));
      }

      // --- Inline styles ---
      const styleClass = INLINE_STYLES[node.name];
      if (styleClass && node.from < node.to) {
        decorations.push(
          Decoration.mark({ class: styleClass }).range(node.from, node.to),
        );
      }

      // --- Links: style the text portion ---
      if (node.name === "Link" && node.from < node.to) {
        decorations.push(
          Decoration.mark({ class: "cm-md-link" }).range(node.from, node.to),
        );
      }

      // --- Horizontal rule ---
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

// --- Dark theme ---
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

// --- App logic ---
const sessionList = document.getElementById("session-list");
const refreshBtn = document.getElementById("refresh-btn");
const emptyState = document.getElementById("empty-state");
const editorContainer = document.getElementById("editor-container");
const editorProject = document.getElementById("editor-project");
const saveStatus = document.getElementById("save-status");
const editorMount = document.getElementById("editor-mount");

let currentSessionId = null;
let saveTimeout = null;
let editorView = null;

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
    li.innerHTML = `
      <div class="session-project">
        <span class="session-status ${s.alive ? "alive" : "dead"}"></span>
        ${s.project || "~"}
      </div>
      <div class="session-id">${s.sessionId.slice(0, 8)}…</div>
    `;
    li.addEventListener("click", () => selectSession(s));
    sessionList.appendChild(li);
  }
}

async function selectSession(session) {
  currentSessionId = session.sessionId;

  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle(
      "active",
      el
        .querySelector(".session-id")
        .textContent.startsWith(session.sessionId.slice(0, 8)),
    );
  });

  emptyState.classList.add("hidden");
  editorContainer.classList.remove("hidden");
  editorProject.textContent = session.project
    ? `${session.project} — ${session.cwd}`
    : session.sessionId;

  const content = await window.api.readIntention(session.sessionId);
  createEditor(content);
  saveStatus.textContent = "";

  await window.api.watchIntention(session.sessionId);
}

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
