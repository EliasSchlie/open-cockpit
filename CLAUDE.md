# Open Cockpit

Electron app + Claude Code plugin for session intention tracking.

For file map and runtime paths see [docs/architecture.md](docs/architecture.md).

## Launching

Never use `open -a Electron.app`, `electron .`, or `npx electron .` — these skip `npm run build` and set `ELECTRON_RUN_AS_NODE=1`.

### Restart production

```bash
cd ~/projects/open-cockpit && DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; unset ELECTRON_RUN_AS_NODE && nohup npm start > /dev/null 2>&1 &
```

Confirm with the user first — disrupts all active sessions. No window? Kill stale instances: `pkill -f "Electron.*open-cockpit"`, then relaunch.

### Dev instance

`cd` into your worktree first:

```bash
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; unset ELECTRON_RUN_AS_NODE && nohup npm run dev > /dev/null 2>&1 &
```

Kill only your instance: same command without the `npm run dev` part.

- `npm start` — production (don't touch during dev)
- `npm run dev` — dev instance, separate user data, safe to restart
- `npm run dev:own-pool` — dev with isolated pool (use when modifying pool)

## Reloading after changes

- **Renderer** (`renderer.js`, `styles.css`, `index.html`): `npm run build`, then Cmd+R
- **Main process** (`main.js`, `preload.js`): kill and restart dev instance
- **Daemon** (`pty-daemon.js`): `kill $(cat ~/.open-cockpit/pty-daemon.pid)`, restart app (kills all terminals)

## Releasing

- **Plugin**: every push to `main` auto-bumps version and updates marketplace. Just push.
- **App**: tag push → CI builds → publish draft. See [docs/releasing.md](docs/releasing.md).

## Native modules

`node-pty` compiles for Electron's Node version via `postinstall`. Manual rebuild: `npx electron-builder install-app-deps`. Symptom if skipped: "Daemon request timeout" on pool init.

## Git & worktrees

`.githooks/` (auto-configured): `pre-commit` (prettier), `post-checkout` (auto-install + build), `post-merge` (auto-build).

Worktrees auto-setup via `post-checkout`. Never use `isolation: "worktree"` from inside `.wt/`.

Merging — always from root worktree:
```bash
cd ~/projects/open-cockpit
gh pr merge <number> --squash
git worktree remove .wt/<name>
git branch -d <branch>
git pull
```

## Conventions

- **Every user-facing action must have a keyboard shortcut.** See [docs/shortcuts.md](docs/shortcuts.md).
- **Every UI element must be keyboard-accessible.** Arrow keys, never require mouse.
- **Every action a user can do, a Claude session should also be able to do.** Use the API.
- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`

## Docs

| Topic | Link |
|-------|------|
| Architecture & file map | [docs/architecture.md](docs/architecture.md) |
| Session lifecycle | [docs/sessions.md](docs/sessions.md) |
| Pool management | [docs/pool.md](docs/pool.md) |
| Idle signals | [docs/idle-signals.md](docs/idle-signals.md) |
| Terminals | [docs/terminals.md](docs/terminals.md) |
| PTY daemon | [docs/pty-daemon.md](docs/pty-daemon.md) |
| API & CLI | [docs/api.md](docs/api.md) |
| Plugin hooks | [docs/hooks.md](docs/hooks.md) |
| Keyboard shortcuts | [docs/shortcuts.md](docs/shortcuts.md) |
| Releasing | [docs/releasing.md](docs/releasing.md) |
| Theme & colors | [docs/theme.md](docs/theme.md) |
| Debug logging | [docs/debug-logging.md](docs/debug-logging.md) |
