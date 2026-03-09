// Dock integration helpers — factory functions and utilities extracted from renderer.js
import { DockLayout, createDefaultLayout, newLeafId } from "./dock-layout.js";

export { DockLayout, createDefaultLayout, newLeafId };

// Tab ID constants — used across renderer and dock-helpers
export const TAB_EDITOR = "editor";
export const TAB_SNAPSHOT = "snapshot";

// Build the editor content DOM (header + mount point)
export function createEditorContainer() {
  const editorContainer = document.createElement("div");
  editorContainer.className = "dock-editor-content";

  const header = document.createElement("div");
  header.className = "dock-editor-header";

  const editorProject = document.createElement("span");
  editorProject.className = "dock-editor-project";
  header.appendChild(editorProject);

  const saveStatus = document.createElement("span");
  saveStatus.className = "dock-save-status";
  header.appendChild(saveStatus);

  editorContainer.appendChild(header);

  const editorMount = document.createElement("div");
  editorMount.className = "dock-editor-mount";
  editorContainer.appendChild(editorMount);

  return { editorContainer, editorMount, editorProject, saveStatus };
}

// Register a terminal entry as a dock tab
export function registerTerminalTab(dock, entry, label) {
  const tabId = `term-${entry.termId}`;
  entry.dockTabId = tabId;
  dock.registerTab(tabId, {
    type: entry.isPoolTui ? "claude" : "terminal",
    label,
    closable: !entry.isPoolTui,
    contentEl: entry.container,
  });
}

// Register the editor tab
export function registerEditorTab(dock, editorContainer) {
  dock.registerTab(TAB_EDITOR, {
    type: TAB_EDITOR,
    label: "Intention",
    closable: false,
    contentEl: editorContainer,
  });
}

// Terminal resize: ResizeObserver catches actual container size changes (sidebar
// toggle, window resize, split drag); dock-resize event catches DOM reattachment
// where container size is unchanged (tab switch, session restore).
export function setupTerminalResize(entry) {
  let pending = false;
  let prevCols = entry.term.cols;
  let prevRows = entry.term.rows;

  const doFit = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!entry.container.offsetParent) return;
      // FitAddon.proposeDimensions() returns undefined when xterm's cell
      // dimensions are 0 — happens when the terminal was opened in a detached
      // or zero-sized container and hasn't painted yet. In that case fit() is
      // a silent no-op, leaving the terminal at wrong cols/rows. Retry after
      // the next paint so xterm can compute font metrics first.
      const proposed = entry.fitAddon.proposeDimensions();
      if (!proposed) {
        requestAnimationFrame(() => doFit());
        return;
      }
      entry.fitAddon.fit();
      const { cols, rows } = entry.term;
      if (cols !== prevCols || rows !== prevRows) {
        prevCols = cols;
        prevRows = rows;
        window.api.ptyResize(entry.termId, cols, rows);
        // Report dims so future pool spawns use actual terminal size
        window.api.reportTerminalDims(cols, rows);
      } else {
        // Dimensions unchanged — force repaint for DOM reattachment cases
        // where the canvas renderer is stale. Skipped when dimensions changed
        // because fit() already triggers a full re-render via terminal.resize().
        entry.term.refresh(0, rows - 1);
      }
    });
  };

  const ro = new ResizeObserver(doFit);
  ro.observe(entry.container);
  window.addEventListener("dock-resize", doFit);

  entry._resizeObserver = ro;
  entry._resizeHandler = doFit;
}

export function teardownTerminalResize(entry) {
  if (entry._resizeObserver) {
    entry._resizeObserver.disconnect();
    entry._resizeObserver = null;
  }
  if (entry._resizeHandler) {
    window.removeEventListener("dock-resize", entry._resizeHandler);
    entry._resizeHandler = null;
  }
}

// Determine the "focused" tab — which dock tab contains the active element.
// Falls back to the last focused leaf if activeElement isn't in any leaf
// (e.g. after a tab close when focus drops to <body>).
export function getFocusedTabId(dock, container) {
  if (!dock) return null;
  const leafEls = container.querySelectorAll(".dock-leaf");
  for (const leafEl of leafEls) {
    if (leafEl.contains(document.activeElement)) {
      const leafId = leafEl.dataset.leafId;
      dock.setFocusedLeaf(leafId);
      return dock.getActiveTabInLeaf(leafId);
    }
  }
  // Fallback: last focused leaf (focus lost after tab close, etc.)
  if (dock.lastFocusedLeafId) {
    return dock.getActiveTabInLeaf(dock.lastFocusedLeafId);
  }
  return null;
}

// Dispose a terminal entry: tear down resize, unregister dock tab, dispose xterm, remove DOM
export function disposeTerminalEntry(entry, dock) {
  teardownTerminalResize(entry);
  if (dock && entry.dockTabId) dock.unregisterTab(entry.dockTabId);
  entry.term.dispose();
  entry.container.remove();
}

// Focus the active tab in a given leaf. Returns true if a tab was activated.
export function focusLeafContent(dock, leafId) {
  const activeTabId = dock.getActiveTabInLeaf(leafId);
  if (!activeTabId) return false;
  dock.activateTab(activeTabId); // fires onTabActivate which focuses the content
  return true;
}
