# Open Cockpit

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
- `~/.open-cockpit/intentions/<session_id>.md` — Intention files (created by app on first open)

## Dev

```bash
npm start       # Build + run
npm run build   # Bundle renderer only (esbuild)
```

## Dev vs production

- `npm start` — production instance (user's daily driver, don't touch during dev)
- `npm run dev` — dev instance with separate user data dir + "DEV" in title, safe to restart freely
- Both can run simultaneously

## Reloading after changes

- **Renderer changes** (`renderer.js`, `styles.css`, `index.html`): `npm run build`, then Cmd+R in the dev window.
- **Main process changes** (`main.js`, `preload.js`): restart the dev instance:
  ```bash
  osascript -e 'quit app "Electron"' 2>/dev/null; sleep 1; npm run dev
  ```

## Conventions

- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`
