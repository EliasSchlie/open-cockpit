# Dev Instances

Dev instances run Open Cockpit in isolated sandboxes — separate state directories, sockets, and daemons — so you can test changes without touching the base (production) instance.

Each Claude session can own **at most one** dev instance, named by its session ID. When the Claude session dies, its dev instance and daemon are automatically cleaned up.

## Quick start

```bash
# Launch a dev instance (auto-detects session ID, kills existing one first)
cockpit-cli --dev dev launch --hidden

# Use the dev instance (--dev auto-routes to this session's instance)
cockpit-cli --dev pool init 3
cockpit-cli --dev start "fix the bug" --block
cockpit-cli --dev screenshot --raw > /tmp/debug.png

# Check status
cockpit-cli --dev dev status

# Kill explicitly (also happens automatically when Claude session exits)
cockpit-cli --dev dev kill
```

## Launch options

```bash
cockpit-cli --dev dev launch                    # Visible window
cockpit-cli --dev dev launch --hidden           # No window (API only)
cockpit-cli --dev dev launch --watch            # Auto-rebuild on src/ changes
cockpit-cli --dev dev launch --cwd /path/to/oc  # Use specific project dir
```

## How it works

1. `--dev` flag walks the PPID chain to find the parent Claude session ID (via `~/.open-cockpit/session-pids/`)
2. Uses the session ID as the instance name → state at `~/.open-cockpit-dev/<session-id>/`
3. `dev launch` passes `--parent-pid` to the Electron app
4. A watchdog checks the parent PID every 10s — if dead, pool destroyed + daemon killed + app quit
5. `dev launch` enforces 1:1 — kills any existing dev instance for this session before starting

One env var — `OPEN_COCKPIT_DIR` — scopes everything:

| Instance | State dir |
|----------|-----------|
| **Base** (production) | `~/.open-cockpit/` |
| **Dev** | `~/.open-cockpit-dev/<session-id>/` |

All paths (pool.json, daemon socket, API socket, etc.) derive from this directory.

## Hidden mode

`--hidden` starts the app without a visible window. The Electron renderer still runs — DOM, IPC, sessions all work — but nothing appears on screen. Control everything via the API.

Show/hide at runtime:

```bash
cockpit-cli --dev show      # Make window visible
cockpit-cli --dev hide      # Hide again
```

## Remote control

```bash
cockpit-cli --dev screenshot --raw > /tmp/debug.png    # Save screenshot
cockpit-cli --dev ui-state                             # Get UI state
cockpit-cli --dev pool status                          # Pool health
cockpit-cli --dev ls                                   # List sessions
```

## Full workflow example

```bash
# 1. Launch hidden instance
cockpit-cli --dev dev launch --hidden

# 2. Init pool
cockpit-cli --dev pool init 2

# 3. Wait for sessions to be ready
sleep 10

# 4. Send a prompt
cockpit-cli --dev start "fix the login bug" --block

# 5. Check what the UI looks like
cockpit-cli --dev screenshot --raw > /tmp/result.png

# 6. Read the result
cockpit-cli --dev result @0

# 7. Kill (or just let it auto-clean when this session exits)
cockpit-cli --dev dev kill
```

## Auto-rebuild (dev:watch)

`cockpit-cli --dev dev launch --watch` starts a file watcher alongside the Electron process:

1. `fs.watch` monitors `src/` recursively
2. On change → debounce 300ms → `npm run build`
3. Dev instance polls `dist/renderer.js` mtime every 2s → `app.relaunch()`
4. Sessions survive via the daemon — terminals reconnect on reload

Edit → app restarts in ~2 seconds.

## Lifecycle

### What happens on quit

- **Dev instances** auto-destroy their pool and daemon on quit
- **Base instance** leaves the daemon and pool alive — terminals persist across restarts
- **Parent watchdog** auto-quits when the parent Claude session dies
- **Relaunch** (`Cmd+Shift+R` or `cockpit-cli relaunch`) skips pool destroy — sessions survive

### Stale state cleanup

```bash
ls ~/.open-cockpit-dev/
rm -rf ~/.open-cockpit-dev/<stale-session-id>/
```

### Daemon stale detection

When daemon source code is newer than the running daemon, the app shows a "Daemon code updated" banner. Click "Restart daemon" to apply (kills terminal connections, sessions survive).

## Comparison with base instance

| Feature | Base (`npm start`) | Dev (`cockpit-cli --dev dev launch`) |
|---------|-------------------|--------------------------------------|
| State dir | `~/.open-cockpit/` | `~/.open-cockpit-dev/<session-id>/` |
| Auto-updater | Active | Disabled |
| Pool on quit | Preserved | Destroyed |
| Daemon on quit | Preserved | Killed |
| Parent watchdog | No | Yes |
| `--hidden` | Not supported | Supported |
| Window title | "Open Cockpit" | "Open Cockpit [session-id]" |

## Manual instances (advanced)

For development outside Claude sessions, you can still use `--instance` directly:

```bash
cd .wt/my-feature/
npm run dev              # Auto-named from worktree
npm run dev:hidden       # Headless
npm run dev:watch        # Auto-rebuild

cockpit-cli --instance my-feature pool status
```

These don't have parent-PID watchdog or 1:1 enforcement.
