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

// Terminal resize via dock-resize + window resize events (replaces per-terminal ResizeObservers)
export function setupTerminalResize(entry) {
  let pending = false;
  const handler = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (entry.container.offsetParent) {
        entry.fitAddon.fit();
        window.api.ptyResize(entry.termId, entry.term.cols, entry.term.rows);
      }
    });
  };
  window.addEventListener("dock-resize", handler);
  window.addEventListener("resize", handler);
  entry._resizeHandler = handler;
}

export function teardownTerminalResize(entry) {
  if (entry._resizeHandler) {
    window.removeEventListener("dock-resize", entry._resizeHandler);
    window.removeEventListener("resize", entry._resizeHandler);
    entry._resizeHandler = null;
  }
}

// Determine the "focused" tab — which dock tab contains the active element
export function getFocusedTabId(dock, container) {
  if (!dock) return null;
  const leafEls = container.querySelectorAll(".dock-leaf");
  for (const leafEl of leafEls) {
    if (leafEl.contains(document.activeElement)) {
      const leafId = leafEl.dataset.leafId;
      return dock.getActiveTabInLeaf(leafId);
    }
  }
  return null;
}

// Focus the first terminal in a given leaf
export function focusLeafContent(dock, leafId, terminals) {
  const activeTabId = dock.getActiveTabInLeaf(leafId);
  if (!activeTabId) return;
  if (activeTabId === TAB_EDITOR) return; // caller handles editor focus
  const entry = terminals.find((t) => t.dockTabId === activeTabId);
  if (entry) {
    dock.activateTab(activeTabId);
    entry.term.focus();
  }
}
