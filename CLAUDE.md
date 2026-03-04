# Claude Sessions

Electron app for managing Claude Code session intentions.

## Architecture

- `src/main.js` — Main process: window, IPC, file watching
- `src/preload.js` — Context bridge (`api` object)
- `src/renderer.js` — CodeMirror 6 live preview editor + session sidebar
- `src/index.html` + `src/styles.css` — Layout, Catppuccin dark theme

## External dependencies

This app reads data written by **Claude Code hooks** (not part of this repo):

- **`session-pid-map.sh`** (SessionStart hook) — writes `~/.claude/session-pids/<PID>` containing the session ID. Without this, the app has no sessions to show.
- **`session-intention.sh`** (SessionStart hook) — creates empty `~/.intentions/<session_id>.md` on session start.

See `docs/hooks.md` for hook setup details.

## Key paths

- `~/.claude/session-pids/` — PID → session ID map (read-only)
- `~/.intentions/<session_id>.md` — Intention files (read/write)

## Dev

```bash
npm start       # Build + run
npm run build   # Bundle renderer only (esbuild)
```

## Conventions

- Electron: contextIsolation + preload, sandbox off (preload needs npm packages)
- CodeMirror 6 for live preview editor (bundled with esbuild)
- Auto-save with 500ms debounce
- File watching via `fs.watchFile` (polling, 500ms — reliable on macOS)
