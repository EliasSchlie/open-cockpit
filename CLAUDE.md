# Open Cockpit

Electron app + Claude Code plugin for session intention tracking.

## Architecture

Key modules — full file index in [docs/architecture.md](docs/architecture.md).

- `src/main.js` — Main process orchestrator
- `src/pty-daemon.js` — PTY daemon ([docs/pty-daemon.md](docs/pty-daemon.md))
- `src/api-server.js` — Unix socket API ([docs/api.md](docs/api.md))
- `src/renderer.js` — Renderer orchestrator
- `src/dock-layout.js` — Dock system (split tree, drag-and-drop tabs)
- `hooks/` — Claude Code plugin hooks ([docs/hooks.md](docs/hooks.md))
- `bin/cockpit-cli` — CLI ([docs/api.md](docs/api.md))

Runtime paths: `~/.open-cockpit/` (see [docs/architecture.md](docs/architecture.md#key-runtime-paths)).

## Dev instances

See [docs/dev-instances.md](docs/dev-instances.md) for full details.

- **From Claude sessions**: `cockpit-cli --dev dev launch --hidden` — session-owned, auto-cleanup on exit
- **Manual** (worktree): `npm run dev` / `npm run dev:watch` — auto-named from `.wt/<name>/`
- All `cockpit-cli` commands work with `--dev` flag to target this session's dev instance

## Reloading after changes

- **With `--watch`** (`cockpit-cli --dev dev launch --watch`): automatic — edit src/, app rebuilds and relaunches within ~2s
- **Without `--watch`**: `npm run build`, then Cmd+R (renderer only) or Cmd+Shift+R (full rebuild + relaunch)
- **Daemon** (`pty-daemon.js`): in-app banner warns when daemon code is stale, click "Restart daemon" (kills all terminals)

## Native modules

`node-pty` must be compiled for Electron's Node version. Happens automatically via `postinstall`. Manual rebuild: `npx electron-builder install-app-deps`

**Symptom if skipped:** Pool init fails with "Daemon request timeout" — daemon crashes on `spawn` due to ABI mismatch.

## Releasing

Two independent pipelines: **plugin** (automatic) and **app** (manual).

- **Plugin**: Every push to `main` auto-bumps `.claude-plugin/plugin.json` and updates the marketplace. Requires `APP_ID` and `APP_PRIVATE_KEY` secrets.
- **App**: Tag push → CI builds all platforms → publish the draft. See [docs/releasing.md](docs/releasing.md).

## Plans

Save plans in intention files, not `docs/plans/`.

## Conventions

- **Every user-facing action must have a keyboard shortcut.** See [docs/shortcuts.md](docs/shortcuts.md).
- **Every UI element must be keyboard-accessible.** Arrow key navigation, never require mouse.
- **Every action a user can do, a Claude session should also be able to do.** Use the API to test programmatically.
- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`

## Further docs

- [docs/architecture.md](docs/architecture.md) — Full file index, runtime paths
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
- [docs/dev-instances.md](docs/dev-instances.md) — Dev instances, launching, hidden mode, remote control
- [docs/debug-logging.md](docs/debug-logging.md) — Debug logging
- [docs/testing/](docs/testing/) — Testing philosophy, isolation strategy
