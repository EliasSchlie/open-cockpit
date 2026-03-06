# Keyboard Shortcuts

## How shortcuts are implemented

Shortcuts flow through three layers:

1. **Menu accelerators** (`src/main.js`) — Electron menu items with dynamic `accelerator` keys from the shortcuts config. These call `send(channel)` which forwards to the renderer via `webContents.send()`.

2. **`before-input-event` handler** (`src/main.js`) — For shortcuts that can't be menu accelerators (e.g., `Ctrl+Tab`, `Cmd+Shift+Tab`, arrow-key combos). Intercepts raw keyboard input and dispatches IPC messages. Uses `matchesInput()` from `src/shortcuts.js` to check against the current config.

3. **Renderer listeners** (`src/renderer.js`) — Registered via `window.api.on<Action>()` callbacks exposed through the preload bridge. Execute the actual UI logic.

### Adding a new shortcut

1. **`src/shortcuts.js`**: Add the action ID and default accelerator to `DEFAULT_SHORTCUTS`. If the shortcut needs `before-input-event` handling (arrow keys, Tab, etc.), add its ID to `INPUT_EVENT_ACTIONS`.
2. **`src/preload.js`**: Add the channel name to the `channels` array (for stale listener cleanup) and expose an `on<Action>` listener in the `contextBridge`.
3. **`src/main.js`**: Add a menu entry with `accelerator: accel("action-id")` and `click: () => send("channel-name")`. If it's an input-event action, add a mapping in `inputEventChannels`.
4. **`src/renderer.js`**:
   - Implement the action function
   - Add a `COMMANDS` entry with `shortcutAction` (for dynamic display) and `action`
   - Add the `SHORTCUT_LABELS` entry (for settings UI)
   - Wire up `window.api.on<Action>(handler)` at the bottom with other listeners

### Shortcut configuration

Users can customize all shortcuts via the **Keyboard Shortcuts** settings dialog (accessible from the command palette).

- **Click** a shortcut key to rebind it (press new key combo, Escape to cancel)
- **Right-click** a shortcut key to unbind it
- **↺** button resets to default

Overrides are stored in `~/.open-cockpit/shortcuts.json`. Only overridden values are saved; missing keys use defaults.

### Command palette

All shortcuts appear in the command palette (`Cmd+/`). The `COMMANDS` array in `renderer.js` defines entries with `id`, `label`, `shortcutAction` (action ID for dynamic shortcut lookup), and `action` (function). Display strings are generated dynamically from the shortcut config.

## Default shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New Claude Session |
| `Cmd+T` | New Terminal Tab |
| `Cmd+W` | Close Terminal Tab |
| `Cmd+Shift+]` / `[` | Next / Previous Tab |
| `Cmd+1`–`9` | Switch to Tab N |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / Previous Tab (alt) |
| `Alt+Down` / `Alt+Up` | Next / Previous Session |
| `Cmd+Shift+Tab` | Cycle Pane Focus (editor → terminals → editor) |
| `Cmd+J` | Jump to Recent Idle Session |
| `Cmd+D` | Archive Current Session |
| `Cmd+\` | Toggle Sidebar |
| `Cmd+E` | Focus Editor |
| `` Cmd+` `` | Focus Terminal |
| `Cmd+O` | Focus External Terminal |
| `Ctrl+Alt+Cmd+C` | Open in Cursor |
| `Escape` | Focus Terminal |
| `Cmd+/` | Command Palette |
| `Cmd+,` | Pool Settings |
| `Cmd+Alt+]` / `[` | Focus Next / Previous Pane |
| *(unbound)* | Toggle Pane Focus (editor ↔ terminal) |
| *(unbound)* | Split Right |
| *(unbound)* | Split Down |
