# Architecture

## Source files

### Main process

- `src/main.js` — Orchestrator: window, IPC wiring, module init
- `src/paths.js` — Shared path constants for all main-process modules
- `src/claude-term-client.js` — Node.js socket client for claude-term (shell terminals)
- `src/claude-pool-client.js` — Node.js socket client for claude-pool (session pools)
- `src/daemon-client.js` — claude-term adapter (legacy pty-daemon API surface)
- `src/api-server.js` — **API server**: Unix socket API for external process control ([api.md](api.md))
- `src/session-discovery.js` — Session state detection, caching, origin tagging
- `src/pool-manager.js` — Pool lifecycle (delegates to claude-pool), intentions, session graph, offload meta
- `src/api-handlers.js` — Shared IPC/API handler registry + API-only handlers
- `src/preload.js` — Context bridge (`api` object)
- `src/shortcuts.js` — Configurable keyboard shortcuts (defaults, overrides, accelerator matching)
- `src/session-statuses.js` — Shared status string constants (STATUS enum)
- `src/platform.js` — Cross-platform abstraction (process introspection, CWD detection, shell config)
- `src/parse-origins.js` — Session origin detection from `ps eww` output (pool/sub-claude/ext)
- `src/secure-fs.js` — File helpers: owner-only write (mode 0o600/0o700), `readJsonSync(path, fallback)`
- `src/sort-sessions.js` — Session display ordering (used by main.js)

### Renderer

- `src/renderer.js` — Orchestrator: session lifecycle, auto-save, IPC wiring, module init
- `src/renderer-state.js` — Shared mutable state, DOM refs, status classes, utilities
- `src/dock-layout.js` — **Dock system**: recursive split tree, drag-and-drop tabs, resize handles
- `src/dock-helpers.js` — Dock integration utilities (editor container factory, terminal resize, tab registration)
- `src/editor.js` — CodeMirror 6 live preview editor setup
- `src/session-sidebar.js` — Session list rendering, directory colors, context menus, snapshots
- `src/terminal-manager.js` — Terminal creation, attach, switch, close, caching, reconnect, PTY IPC
- `src/pool-ui.js` — Pool settings panel, slot terminal popup, shortcut settings
- `src/command-palette.js` — COMMANDS registry, pane navigation, palette UI
- `src/session-search.js` — Fuzzy session search overlay (⌘K)
- `src/session-stats.js` — On-demand JSONL parsing, token/cost stats, sub-agent aggregation
- `src/agent-picker.js` — Agent picker overlay (discover and run named agents)
- `src/stats-ui.js` — Session Info overlay dialog (⌘I)
- `src/index.html` + `src/styles.css` — Layout, neon red dark theme

### Plugin & CI

- `bin/cockpit-cli` — CLI for observing and interacting with agents ([api.md](api.md))
- `hooks/` — Claude Code plugin hooks ([hooks.md](hooks.md))
- `.claude-plugin/plugin.json` — Plugin manifest
- `.github/workflows/auto-release.yml` — CI auto-bumps plugin version on push
- `.github/workflows/build-release.yml` — CI builds Electron binaries on tag push ([releasing.md](releasing.md))

## Key runtime paths

All paths derive from `OPEN_COCKPIT_DIR` (defaults to `~/.open-cockpit/`). See [dev-instances.md](dev-instances.md) for how dev/test instances scope to separate directories.

| Path | Purpose |
|------|---------|
| `pool-settings.json` | Pool settings (session flags) |
| `session-pids/<PID>` | Session ID mapping (written by hooks) |
| `intentions/<session_id>.md` | Intention files |
| `idle-signals/<PID>` | Idle signal files |
| `session-graph.json` | Parent-child relationships |
| `offloaded/<sessionId>/` | Offloaded/archived data |
| `shortcuts.json` | Keyboard shortcut overrides |
| `setup-scripts/` | Setup scripts for Cmd+N |
| `agents/` | Global agent scripts ([agents.md](agents.md)) |
| `colors.json` | Directory color overrides |
| `debug.log` | Debug log (rotates at 2 MB) |
| `api.sock` | API socket |
