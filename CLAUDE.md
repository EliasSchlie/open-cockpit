# Claude Sessions

Electron app + Claude Code plugin for session intention tracking.

## Architecture

- `src/main.js` — Main process: window, IPC, file watching, session discovery
- `src/preload.js` — Context bridge (`api` object)
- `src/renderer.js` — CodeMirror 6 live preview editor + session sidebar
- `src/index.html` + `src/styles.css` — Layout, Catppuccin dark theme
- `hooks/` — Claude Code plugin hooks (SessionStart → PID mapping)
- `.claude-plugin/plugin.json` — Plugin manifest

## Key paths

- `~/.claude/session-pids/<PID>` — Session ID (written by plugin hook)
- `~/.intentions/<session_id>.md` — Intention files (created by app on first open)

## Dev

```bash
npm start       # Build + run
npm run build   # Bundle renderer only (esbuild)
```

## Conventions

- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`
