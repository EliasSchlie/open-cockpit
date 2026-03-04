# Open Cockpit

Electron app + Claude Code plugin for session intention tracking.

## Architecture

- `src/main.js` — Main process: window, IPC, file watching, session discovery
- `src/preload.js` — Context bridge (`api` object)
- `src/renderer.js` — CodeMirror 6 live preview editor + session sidebar
- `src/index.html` + `src/styles.css` — Layout, neon red dark theme
- `hooks/` — Claude Code plugin hooks (SessionStart → PID mapping)
- `.claude-plugin/plugin.json` — Plugin manifest

## Key paths

- `~/.claude/session-pids/<PID>` — Session ID (written by plugin hook)
- `~/.open-cockpit/intentions/<session_id>.md` — Intention files (created by app on first open)
- `~/.open-cockpit/colors.json` — Directory color overrides ([docs/theme.md](docs/theme.md))

## Dev

```bash
npm start       # Build + run
npm run build   # Bundle renderer only (esbuild)
```

## Dev vs production

- `npm start` — production instance (user's daily driver, don't touch during dev)
- `npm run dev` — dev instance with separate user data dir + "DEV" in title, safe to restart freely
- Both can run simultaneously
- Multiple Claude sessions may run dev instances concurrently from different worktrees

## Managing dev instances (multi-session safe)

Multiple Claude sessions may work on different worktrees simultaneously. Electron processes inherit the `cwd` of the worktree — use `lsof` to identify and kill only yours.

**Launch:** `npm run dev &`

**Kill only YOUR worktree's instance:**
```bash
lsof -c Electron 2>/dev/null | grep "cwd.*$(pwd)" | awk '{print $2}' | sort -u | xargs kill 2>/dev/null
```

**Restart (kill + relaunch):**
```bash
lsof -c Electron 2>/dev/null | grep "cwd.*$(pwd)" | awk '{print $2}' | sort -u | xargs kill 2>/dev/null; sleep 0.5; npm run dev &
```

**NEVER** use `pkill -f electron` or `killall Electron` — this kills other sessions' instances and the production app.

## Reloading after changes

- **Renderer changes** (`renderer.js`, `styles.css`, `index.html`): `npm run build`, then Cmd+R in the dev window.
- **Main process changes** (`main.js`, `preload.js`): kill and restart your dev instance (see commands above).

## Further docs

- [docs/theme.md](docs/theme.md) — Color scheme, directory color coding, user overrides
- [docs/hooks.md](docs/hooks.md) — Plugin hooks

## Conventions

- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`
