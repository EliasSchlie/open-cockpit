# Open Cockpit

Electron app + Claude Code plugin for session intention tracking.

## Architecture

- `src/pty-daemon.js` — **PTY daemon**: standalone process managing all terminals ([docs/pty-daemon.md](docs/pty-daemon.md))
- `src/api-server.js` — **API server**: Unix socket API for external process control ([docs/api.md](docs/api.md))
- `src/main.js` — Main process: window, IPC, daemon client, session discovery
- `src/preload.js` — Context bridge (`api` object)
- `src/pool.js` — Pure pool data structures (readPool, writePool, computePoolHealth)
- `src/renderer.js` — CodeMirror 6 live preview editor + session sidebar
- `src/index.html` + `src/styles.css` — Layout, neon red dark theme
- `bin/cockpit-cli` — CLI helper for API (socat + node fallback)
- `hooks/` — Claude Code plugin hooks (PID mapping, intention intro, idle/fresh signal detection, intention change notify)
- `.claude-plugin/plugin.json` — Plugin manifest
- `release.sh` — Version bump + marketplace deployment

## Pool management

The app can manage a pool of pre-started Claude sessions. Pool state lives in `~/.open-cockpit/pool.json`.

- **Init**: via UI or API (`pool-init` with size). Spawns Claude sessions via the PTY daemon using `resolveClaudePath()` (finds `claude` binary via `which` + fallback paths).
- **Dead slots**: `reconcilePool()` auto-restarts dead slots on app startup.
- **Offloading**: Idle sessions get offloaded (snapshot + `/clear`). External `/clear` is also detected and saved as offloaded.
- **Destroy**: `pool-destroy` kills all slots and removes `pool.json`.

### Plugin update → pool reinit

After releasing a plugin update (`./release.sh`), the hooks need 1–2 minutes to auto-update via the marketplace. Pool sessions started before the update have stale hooks. To pick up new hooks:

1. Wait 1–2 minutes after release for auto-update
2. Destroy the pool (`pool-destroy` via API or UI)
3. Re-initialize (`pool-init`)

New sessions will have the latest hooks.

## Key paths

- `~/.claude/session-pids/<PID>` — Session ID (written by plugin hook)
- `~/.open-cockpit/intentions/<session_id>.md` — Intention files (created by app on first open)
- `~/.open-cockpit/colors.json` — Directory color overrides ([docs/theme.md](docs/theme.md))
- `~/.open-cockpit/idle-signals/<PID>` — Idle signal files (written by plugin hooks)
- `~/.open-cockpit/pool.json` — Pool state (slots, sizes, session mappings)
- `~/.open-cockpit/offloaded/<sessionId>/` — Offloaded session data (meta.json, snapshot.log)
- `~/.open-cockpit/api.sock` — Programmatic API Unix socket
- `~/.open-cockpit/pty-daemon.sock` — PTY daemon Unix socket
- `~/.open-cockpit/pty-daemon.pid` — PTY daemon PID file

## Dev

```bash
npm run build   # Bundle renderer only (esbuild)
```

### Opening the production instance

`npm start` launches the production instance. It exits immediately while Electron runs in the background — **running it twice stacks instances**. Always use this kill-before-launch command:

```bash
cd ~/Documents/Projects/open-cockpit && DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; nohup npm start > /dev/null 2>&1 &
```

## Releasing

```bash
./release.sh        # auto-increments patch (0.1.0 → 0.1.1)
./release.sh 1.0.0  # explicit version
```

Bumps version in `.claude-plugin/plugin.json` and `EliasSchlie/claude-plugins` marketplace, commits, pushes both. Marketplace has `autoUpdate: true` — new sessions pick up changes automatically. **Run after pushing any hook changes.**

## Dev vs production

- `npm start` — production instance (user's daily driver, don't touch during dev)
- `npm run dev` — dev instance with separate user data dir + "DEV" in title, safe to restart freely
- Both can run simultaneously
- Multiple Claude sessions may run dev instances concurrently from different worktrees

## Worktree setup

A `post-checkout` git hook auto-runs `npm install` + `npm run build` when creating worktrees. No manual setup needed — just `git worktree add` and it's ready.

## Managing dev instances (multi-session safe)

Multiple Claude sessions may work on different worktrees simultaneously. Electron processes inherit the `cwd` of the worktree — use `lsof` to identify and kill only yours.

> ⚠️ **CRITICAL: You MUST `cd` into your worktree/project directory before running the kill/launch command.** The command uses `$(pwd)` to scope which Electron process to kill. Running it from `~` or any other directory risks killing the **production instance** if it was launched from that directory.

**Always use this command to launch** (kills any existing instance first — safe even on first launch):
```bash
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; nohup npm run dev > /dev/null 2>&1 &
```

> ⚠️ `npm run dev` exits immediately while Electron stays running in the background.
> It will *look* like it died — it didn't. Always kill-before-launch to avoid stacking instances.
> The daemon PID is excluded so terminals survive restarts.

**Kill only YOUR worktree's instance:**
```bash
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null
```

**NEVER** use `pkill -f electron`, `killall Electron`, or `grep "cwd.*$(pwd)"` (substring match) — these can kill other sessions' instances or the production app. Always use exact `$NF == dir` matching as shown above.

## Reloading after changes

- **Renderer changes** (`renderer.js`, `styles.css`, `index.html`): `npm run build`, then Cmd+R in the dev window. Terminals survive (daemon keeps them alive).
- **Main process changes** (`main.js`, `preload.js`): kill and restart your dev instance (see commands above). Terminals survive (daemon keeps them alive).
- **Daemon changes** (`pty-daemon.js`): kill daemon (`kill $(cat ~/.open-cockpit/pty-daemon.pid)`), then restart app. This kills all terminals.

## Further docs

- [docs/pty-daemon.md](docs/pty-daemon.md) — PTY daemon architecture, protocol, debugging
- [docs/theme.md](docs/theme.md) — Color scheme, directory color coding, user overrides
- [docs/hooks.md](docs/hooks.md) — Plugin hooks
- [docs/api.md](docs/api.md) — Programmatic API (Unix socket, CLI helper)

## Terminal tab model

- **Pool sessions** (non-external): The first terminal tab shows the **live Claude TUI** from the pool slot (attached via daemon). Users interact with Claude directly through this tab.
- **External sessions** (started outside the app): First tab is a fresh shell, since the app doesn't own their terminal.
- **Additional tabs** (via "+" in the tab bar): Always fresh shells at the session's cwd.

Tab labeled "Claude" for pool TUI, "Terminal N" for shells. Pool TUI tabs detach on close (don't kill the daemon PTY). Falls back to fresh shell if pool slot not found or attach fails.

## Session lifecycle

```
fresh → processing → idle → offloaded (graceful /clear, snapshot saved)
                       ↓
                     dead → archived (process died, no snapshot)
```

- **fresh** — pool slot with Claude ready, no user interaction yet
- **processing** — Claude is actively working
- **idle** — Claude finished, waiting for user input
- **offloaded** — session `/clear`'d, conversation saved (meta.json + snapshot.log), slot reused
- **dead** — Claude process exited unexpectedly
- **archived** — dead session with intention file on disk, resumable via `/resume <uuid>`

Both offloaded and archived sessions can be resumed by clicking them in the sidebar (auto-runs `/resume` in a pool slot). **Archived not yet implemented** — see [#36](https://github.com/EliasSchlie/open-cockpit/issues/36).

## Conventions

- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`
