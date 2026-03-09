# Architecture

Electron app + Claude Code plugin for session intention tracking.

## Source files

### Main process

| File | Purpose |
|------|---------|
| `src/main.js` | Main process orchestrator: window, IPC wiring, module init |
| `src/paths.js` | Shared path constants for all main-process modules |
| `src/daemon-client.js` | PTY daemon socket communication (init pattern) |
| `src/session-discovery.js` | Session state detection, caching, origin tagging |
| `src/pool-manager.js` | Pool lifecycle, offload/archive, terminal helpers |
| `src/api-handlers.js` | Shared IPC/API handler registry + API-only handlers |
| `src/preload.js` | Context bridge (`api` object) |
| `src/shortcuts.js` | Configurable keyboard shortcuts (defaults, overrides, accelerator matching) |
| `src/pool.js` | Pure pool data structures (readPool, writePool, computePoolHealth) |
| `src/pool-lock.js` | Async mutex for pool.json read-modify-write cycles (`withPoolLock`) |
| `src/session-statuses.js` | Shared constants: STATUS, POOL_STATUS, ORIGIN enums |
| `src/platform.js` | Cross-platform abstraction (process introspection, CWD, shell config) |
| `src/parse-origins.js` | Session origin detection from `ps eww` output |
| `src/secure-fs.js` | File helpers: owner-only write (mode 0o600/0o700), `readJsonSync` |
| `src/terminal-input.js` | Headless terminal emulator for detecting text in Claude's TUI input box |
| `src/sort-sessions.js` | Session display ordering |

### Standalone processes

| File | Purpose |
|------|---------|
| `src/pty-daemon.js` | PTY daemon: standalone process managing all terminals ([docs](pty-daemon.md)) |
| `src/api-server.js` | Unix socket API for external process control ([docs](api.md)) |

### Renderer (ES modules)

| File | Purpose |
|------|---------|
| `src/renderer.js` | Renderer orchestrator: session lifecycle, auto-save, IPC wiring, module init |
| `src/renderer-state.js` | Shared mutable state, DOM refs, status classes, utilities |
| `src/editor.js` | CodeMirror 6 live preview editor setup |
| `src/session-sidebar.js` | Session list rendering, directory colors, context menus, snapshots |
| `src/terminal-manager.js` | Terminal creation, attach, switch, close, caching, reconnect, PTY IPC |
| `src/pool-ui.js` | Pool settings panel, slot terminal popup, shortcut settings |
| `src/picker-overlay.js` | Shared overlay picker factory (open/close, keyboard nav, click-outside) |
| `src/command-palette.js` | COMMANDS registry, pane navigation, palette UI |
| `src/session-search.js` | Fuzzy session search overlay (⌘K) |
| `src/session-stats.js` | On-demand JSONL parsing, token/cost stats, sub-agent aggregation |
| `src/stats-ui.js` | Session Info overlay dialog (⌘I) |
| `src/dock-layout.js` | Dock system: recursive split tree, drag-and-drop tabs, resize handles |
| `src/dock-helpers.js` | Dock integration utilities (editor container factory, terminal resize) |

### Other

| File | Purpose |
|------|---------|
| `src/index.html` + `src/styles.css` | Layout, neon red dark theme |
| `bin/cockpit-cli` | CLI for observing and interacting with agents ([docs](api.md)) |
| `skills/cockpit-sessions/` | Skill docs for Claude Code (SKILL.md + sub-skills) |
| `hooks/` | Claude Code plugin hooks ([docs](hooks.md)) |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.github/workflows/auto-release.yml` | CI auto-bumps plugin version on push |
| `.github/workflows/build-release.yml` | CI builds Electron binaries on tag push ([docs](releasing.md)) |

## Key paths

| Path | Purpose |
|------|---------|
| `~/.open-cockpit/pool.json` | Pool state |
| `~/.open-cockpit/pool-settings.json` | Pool settings (session flags) |
| `~/.open-cockpit/session-pids/<PID>` | Session ID mapping |
| `~/.open-cockpit/intentions/<session_id>.md` | Intention files |
| `~/.open-cockpit/idle-signals/<PID>` | Idle signal files |
| `~/.open-cockpit/session-graph.json` | Parent-child relationships |
| `~/.open-cockpit/offloaded/<sessionId>/` | Offloaded/archived data |
| `~/.open-cockpit/shortcuts.json` | Keyboard shortcut overrides |
| `~/.open-cockpit/setup-scripts/` | Setup scripts for Cmd+N |
| `~/.open-cockpit/colors.json` | Directory color overrides |
| `~/.open-cockpit/debug.log` | Debug log (rotates at 2 MB) |
| `~/.open-cockpit/api.sock` / `api-dev.sock` | API sockets |
| `~/.open-cockpit/pty-daemon.sock` / `pty-daemon.pid` | PTY daemon |
