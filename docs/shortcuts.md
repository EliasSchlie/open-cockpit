# Keyboard Shortcuts

## How shortcuts are implemented

Shortcuts flow through three layers:

1. **Menu accelerators** (`src/main.js`) — Electron menu items with `accelerator` keys (e.g., `CmdOrCtrl+N`). These call `send(channel)` which forwards to the renderer via `webContents.send()`.

2. **`before-input-event` handler** (`src/main.js`) — For shortcuts that can't be menu accelerators (e.g., `Ctrl+Tab`, `Escape`). Intercepts raw keyboard input and dispatches IPC messages.

3. **Renderer listeners** (`src/renderer.js`) — Registered via `window.api.on<Action>()` callbacks exposed through the preload bridge. Execute the actual UI logic.

### Adding a new shortcut

1. **`src/preload.js`**: Add the channel name to the `channels` array (for stale listener cleanup) and expose an `on<Action>` listener in the `contextBridge`.
2. **`src/main.js`**: Add a menu entry with `accelerator` and `click: () => send("channel-name")` in the appropriate menu section.
3. **`src/renderer.js`**:
   - Implement the action function
   - Add a `COMMANDS` entry (for command palette visibility)
   - Wire up `window.api.on<Action>(handler)` at the bottom with other listeners

### Command palette

All shortcuts should also appear in the command palette (`Cmd+/`). The `COMMANDS` array in `renderer.js` defines entries with `id`, `label`, `shortcut` (display string), and `action` (function).

## Current shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New Claude Session |
| `Cmd+T` | New Terminal Tab |
| `Cmd+W` | Close Terminal Tab |
| `Cmd+Shift+]` / `[` | Next / Previous Tab |
| `Cmd+1`–`9` | Switch to Tab N |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / Previous Tab (alt) |
| `Alt+Down` / `Alt+Up` | Next / Previous Session |
| `Cmd+J` | Jump to Recent Idle Session |
| `Cmd+D` | Archive Current Session |
| `Cmd+\` | Toggle Sidebar |
| `Alt+Left` / `Alt+Right` | Toggle Pane Focus |
| `Cmd+E` | Focus Editor |
| `` Cmd+` `` | Focus Terminal |
| `Escape` | Focus Terminal |
| `Cmd+/` | Command Palette |
