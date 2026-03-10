# Open Cockpit

Electron app + Claude Code plugin for session intention tracking.

## Architecture

- `src/pty-daemon.js` — **PTY daemon**: standalone process managing all terminals ([docs/pty-daemon.md](docs/pty-daemon.md))
- `src/api-server.js` — **API server**: Unix socket API for external process control ([docs/api.md](docs/api.md))
- `src/main.js` — Main process orchestrator: window, IPC wiring, module init
- `src/paths.js` — Shared path constants for all main-process modules
- `src/daemon-client.js` — PTY daemon socket communication (init pattern)
- `src/session-discovery.js` — Session state detection, caching, origin tagging
- `src/pool-manager.js` — Pool lifecycle, offload/archive, terminal helpers
- `src/api-handlers.js` — Shared IPC/API handler registry + API-only handlers
- `src/preload.js` — Context bridge (`api` object)
- `src/shortcuts.js` — Configurable keyboard shortcuts (defaults, overrides, accelerator matching)
- `src/pool.js` — Pure pool data structures (readPool, writePool, computePoolHealth)
- `src/pool-lock.js` — Async mutex for pool.json read-modify-write cycles (`withPoolLock`)
- `src/session-statuses.js` — Shared status string constants (STATUS enum)
- `src/platform.js` — Cross-platform abstraction (process introspection, CWD detection, shell config, macOS-only features no-op elsewhere)
- `src/parse-origins.js` — Session origin detection from `ps eww` output (pool/sub-claude/ext)
- `src/secure-fs.js` — File helpers: owner-only write (mode 0o600/0o700), `readJsonSync(path, fallback)`
- `src/terminal-input.js` — Headless terminal emulator for detecting text in Claude's TUI input box
- `src/sort-sessions.js` — Session display ordering (used by main.js)
- `src/dock-layout.js` — **Dock system**: recursive split tree, drag-and-drop tabs, resize handles
- `src/dock-helpers.js` — Dock integration utilities (editor container factory, terminal resize, tab registration)
- `src/renderer.js` — Renderer orchestrator: session lifecycle, auto-save, IPC wiring, module init
- `src/renderer-state.js` — Shared mutable state, DOM refs, status classes, utilities
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
- `bin/cockpit-cli` — CLI for observing and interacting with agents ([docs/api.md](docs/api.md))
- `skills/cockpit-sessions/` — Skill docs for Claude Code (SKILL.md + sub-skills)
- `hooks/` — Claude Code plugin hooks ([docs/hooks.md](docs/hooks.md))
- `.claude-plugin/plugin.json` — Plugin manifest
- `.github/workflows/auto-release.yml` — CI auto-bumps plugin version on push
- `.github/workflows/build-release.yml` — CI builds Electron binaries on tag push ([docs/releasing.md](docs/releasing.md))

## Key paths

- `~/.open-cockpit/pool.json` — Pool state
- `~/.open-cockpit/pool-settings.json` — Pool settings (session flags)
- `~/.open-cockpit/session-pids/<PID>` — Session ID mapping
- `~/.open-cockpit/intentions/<session_id>.md` — Intention files
- `~/.open-cockpit/idle-signals/<PID>` — Idle signal files
- `~/.open-cockpit/session-graph.json` — Parent-child relationships
- `~/.open-cockpit/offloaded/<sessionId>/` — Offloaded/archived data
- `~/.open-cockpit/shortcuts.json` — Keyboard shortcut overrides
- `~/.open-cockpit/setup-scripts/` — Setup scripts for Cmd+N
- `~/.open-cockpit/agents/` — Global agent scripts ([docs/agents.md](docs/agents.md))
- `~/.open-cockpit/active-sessions.json` — Crash-recovery registry of active sessions (continuously updated)
- `~/.open-cockpit/pending-restore.json` — Sessions to auto-resume on next pool init (legacy, transient)
- `~/.open-cockpit/colors.json` — Directory color overrides
- `~/.open-cockpit/debug.log` — Debug log (rotates at 2 MB)
- `~/.open-cockpit/api.sock` — API socket (scoped to `OPEN_COCKPIT_DIR`)
- `~/.open-cockpit/pty-daemon.sock` / `pty-daemon.pid` — PTY daemon (scoped to `OPEN_COCKPIT_DIR`)

## Launching the app

Do not use `open -a Electron.app`, `electron .`, or `npx electron .` — these skip `npm run build` and set `ELECTRON_RUN_AS_NODE=1`.

### Restart production

```bash
cd ~/projects/open-cockpit && DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; unset ELECTRON_RUN_AS_NODE && nohup npm start > /dev/null 2>&1 &
```

Confirm with the user before restarting production — it disrupts all active sessions.

**No window?** Stale instances. Kill all: `pkill -f "Electron.*open-cockpit"`, then relaunch.

### Launch dev instance

`cd` into your worktree first:

```bash
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; unset ELECTRON_RUN_AS_NODE && nohup npm run dev > /dev/null 2>&1 &
```

### Kill only your worktree's instance

```bash
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null
```

Do not use `pkill -f electron` or `killall Electron` — these can kill other instances.

## Releasing

Two independent pipelines: **plugin** (automatic) and **app** (manual).

### Plugin releases

Every push to `main` auto-bumps `.claude-plugin/plugin.json` and updates the marketplace. Just push — CI handles it.

**Requires:** `APP_ID` and `APP_PRIVATE_KEY` secrets (Plugin Release Bot GitHub App).

### App releases

Tag push → CI builds all platforms → publish the draft. See [docs/releasing.md](docs/releasing.md) for full steps, secrets, and troubleshooting.

## Dev vs production

- `npm start` — base instance (no isolation, don't touch during dev)
- `npm run dev` — dev instance, auto-named from worktree (e.g. `.wt/my-feature/` → `--instance my-feature`)
- `npm run dev:watch` — same + auto-rebuild on `src/` changes, app auto-relaunches
- Custom: `electron . --instance my-name` — explicit name
- Dev instances require a name — `npm run dev` from root repo (not a worktree) errors

## Reloading after changes

- **With `dev:watch`**: automatic — edit src/, app rebuilds and relaunches within ~2s
- **Without `dev:watch`**: `npm run build`, then Cmd+R (renderer only) or kill + restart (main process)
- **Daemon** (`pty-daemon.js`): in-app banner warns when daemon code is stale, click "Restart daemon" (kills all terminals)

## Native modules

`node-pty` must be compiled for Electron's Node version. Happens automatically via `postinstall`. Manual rebuild: `npx electron-builder install-app-deps`

**Symptom if skipped:** Pool init fails with "Daemon request timeout" — daemon crashes on `spawn` due to ABI mismatch.

## Git hooks

`.githooks/` (auto-configured via `prepare` script):
- `pre-commit` — prettier
- `pre-push` — runs tests + rejects merge commits in feature branches
- `post-checkout` — auto-install deps + build for worktrees
- `post-merge` — auto-build after pull

## Branching

**Rebase, never merge.** Feature branches must not contain merge commits — the pre-push hook and CI (`no-merge-commits.yml`) enforce this. To update a branch:
```bash
git fetch origin
git rebase origin/main
```
Merge commits inside feature branches can silently drop code during conflict resolution (see #340).

## Worktree setup

Worktrees auto-setup via `post-checkout`. Never use `isolation: "worktree"` from inside a `.wt/` directory.

Merging: always merge from root worktree without `--delete-branch`:
```bash
cd ~/projects/open-cockpit
gh pr merge <number> --squash
git worktree remove .wt/<name>
git branch -d <branch>
git pull
```

## Plans

Save plans to `docs/plans/` (e.g. `docs/plans/2026-03-09-feature-name.md`).

## Conventions

- **Every user-facing action must have a keyboard shortcut.** See [docs/shortcuts.md](docs/shortcuts.md).
- **Every UI element must be keyboard-accessible.** Arrow key navigation, never require mouse.
- **Every action a user can do, a Claude session should also be able to do.** Use the API to test programmatically.
- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`

## Further docs

- [docs/releasing.md](docs/releasing.md) — App release workflow, code signing, secrets
- [docs/sessions.md](docs/sessions.md) — Session lifecycle, idle detection, archiving, graph, pinning, origins
- [docs/pool.md](docs/pool.md) — Pool management internals
- [docs/terminals.md](docs/terminals.md) — Terminal tab model, attach strategy, programmatic access
- [docs/pty-daemon.md](docs/pty-daemon.md) — PTY daemon architecture, protocol, debugging
- [docs/api.md](docs/api.md) — Programmatic API (Unix socket, CLI)
- [docs/hooks.md](docs/hooks.md) — Plugin hooks
- [docs/agents.md](docs/agents.md) — Custom agent scripts
- [docs/shortcuts.md](docs/shortcuts.md) — Keyboard shortcuts reference
- [docs/theme.md](docs/theme.md) — Color scheme, directory colors
- [docs/debug-logging.md](docs/debug-logging.md) — Debug logging
- [docs/testing/](docs/testing/) — Testing philosophy, isolation strategy
