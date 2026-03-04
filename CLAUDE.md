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
- `~/.open-cockpit/colors.json` — User color overrides for directory indicators (see Theme section)

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

Multiple Claude sessions may work on different worktrees simultaneously. Each must manage only its own dev instance. Electron processes inherit the `cwd` of the worktree they were launched from — use `lsof` to identify yours.

**Launch:**
```bash
npm run dev &
```

**Kill only YOUR worktree's dev instance:**
```bash
lsof -c Electron 2>/dev/null | grep "cwd.*$(pwd)" | awk '{print $2}' | sort -u | xargs kill 2>/dev/null
```

**Restart (kill + relaunch):**
```bash
lsof -c Electron 2>/dev/null | grep "cwd.*$(pwd)" | awk '{print $2}' | sort -u | xargs kill 2>/dev/null; sleep 0.5; npm run dev &
```

**NEVER** use `pkill -f electron` or `killall Electron` — this kills other sessions' dev instances and the production app.

## Reloading after changes

- **Renderer changes** (`renderer.js`, `styles.css`, `index.html`): `npm run build`, then Cmd+R in the dev window.
- **Main process changes** (`main.js`, `preload.js`): kill and restart your dev instance (see commands above).

## Theme & directory color coding

Dark black (`#0a0a0a`) background with neon red (`#ff1a1a`) accents. CSS vars in `:root` of `styles.css`, CodeMirror colors hardcoded in `renderer.js` theme objects.

**Session color coding** — each session gets a colored sidebar indicator and editor header bar based on its working directory:
- Colors are deterministic (hash-based) — same directory always gets the same color
- Git repo subdirs all share the repo root's color (detected via `.git` directory walk-up)
- Worktree paths (`.claude/worktrees/xxx`, `.wt/xxx`) resolve to parent project's color
- Home directory (`~`) gets no color
- xterm theme is minimal (background + cursor only) — shell's own ANSI colors are preserved

**User overrides** via `~/.open-cockpit/colors.json`:
```json
{
  "~/Documents/Projects/my-app": "#ff00ff",
  "~/Documents/Projects/boring": null
}
```
- Keys are tilde-prefixed paths, matched by longest prefix
- `null` = no color (transparent), string = exact hex color
- Reloads on sidebar refresh (↻ button), no restart needed

## Conventions

- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`
