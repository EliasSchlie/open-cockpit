# Draggable Tab-Based Panel System — Full IDE-Style Docking

## Goal

Replace the fixed terminal-left/editor-right layout with a fully flexible docking system:
- **Arbitrary splits** — horizontal and vertical, nestable to any depth
- **3 tab types**: Claude (pool TUI), Terminal (shells), Intention (editor) — all behave the same
- **Claude and Intention tabs can't be closed**, but can be moved anywhere
- **Drag-and-drop**: drag to center = stack, drag to edge = split
- **Resizable dividers** between all split panes
- Default layout: [Claude | Intention] side-by-side

## Layout Model — Recursive Split Tree

```
LayoutNode = SplitNode | LeafNode

SplitNode { type: 'split', direction: 'horizontal'|'vertical', children: LayoutNode[], sizes: number[] }
LeafNode  { type: 'leaf', id: string, tabs: string[], activeTab: number }
```

Default:
```
Split(horizontal, [
  Leaf([claude-tab, terminal-1, ...]),
  Leaf([editor-tab])
], [50, 50])
```

## Drop Zone Detection

Mouse position within a leaf's content area:
- Center (inner 50%) → stack tab in this leaf
- Top/Bottom/Left/Right edge (outer 25%) → split leaf in that direction
- Over tab bar → always center/stack

Same-direction merging: dropping left/right on a horizontal split inserts as sibling (no unnecessary nesting).

## Files

| File | Change |
|------|--------|
| `src/dock-layout.js` | **NEW** — DockLayout class, tree ops, rendering, drag-and-drop, resize |
| `src/index.html` | Replace session-view internals with dock container |
| `src/styles.css` | Add dock styles (~100 lines) |
| `src/renderer.js` | Integrate dock — each terminal is its own dock tab |

## Renderer Integration

- `terminals[]` array stays as source of truth for terminal entries
- Each entry gets a `dockTabId` field
- `editorContainer` created dynamically (header + CodeMirror mount)
- Dock callbacks handle tab close, activation, new terminal
- Session cache stores dock layout alongside terminal entries
- ResizeObservers replaced by `dock-resize` window event
- `switchToTerminal`/`renderTerminalTabs` replaced by dock methods
