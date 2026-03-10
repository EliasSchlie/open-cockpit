# Dev Instances

Dev instances run Open Cockpit in isolated sandboxes — separate state directories, sockets, and daemons — so you can test changes without touching the base (production) instance.

## Launching

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

Do not use `pkill -f electron` or `killall Electron` — these can kill other instances.

## Quick start

```bash
# From a worktree:
cd .wt/my-feature/
npm run dev                     # Visible window, auto-named "my-feature"
npm run dev:hidden              # No window — API only
npm run dev:watch               # Visible + auto-rebuild on src/ changes

# With explicit name:
electron . --instance my-test --dev
electron . --instance my-test --dev --hidden
```

## How it works

One env var — `OPEN_COCKPIT_DIR` — scopes everything. The `--instance` flag (or worktree auto-detection) sets it:

| Instance | `OPEN_COCKPIT_DIR` | State dir |
|----------|-------------------|-----------|
| **Base** (production) | _(unset)_ | `~/.open-cockpit/` |
| **Dev** | `~/.open-cockpit-dev/<name>/` | same |
| **Test** | `~/.open-cockpit-test/<name>/` | same |

All paths — pool.json, daemon socket, API socket, intentions, session-pids — derive from `OPEN_COCKPIT_DIR`. No branching logic, no special cases.

### Instance naming

- **Worktree auto-detect**: `.wt/<name>/` in the cwd → instance name `<name>`
- **Explicit**: `--instance <name>` flag
- **Requirement**: `--dev` flag always requires a name (errors if run from root repo without `--instance`)

### CLI routing

Address any instance by name:

```bash
cockpit-cli --instance my-feature pool status
cockpit-cli --instance my-feature screenshot --raw > debug.png
cockpit-cli --instance my-feature session-select abc123
```

The CLI resolves the socket at `~/.open-cockpit-dev/<name>/api.sock`.

## Hidden mode

`--hidden` starts the app without a visible window. The full Electron renderer still runs — DOM is rendered, IPC is active, sessions work — but nothing appears on screen. Control everything via the API.

```bash
npm run dev:hidden              # Launch hidden from worktree
```

### Why use it?

- **Agent testing**: Spin up headless instances for automated test harnesses
- **CI pipelines**: Run the full app without a display (Electron's offscreen rendering)
- **Background monitoring**: Keep an instance running without dock/taskbar clutter

### Showing and hiding at runtime

```bash
cockpit-cli --instance my-dev show     # Make window visible
cockpit-cli --instance my-dev hide     # Hide again
```

The `show` command also works as a debugging escape hatch — if you launched hidden and need to inspect the UI, just `show`.

## Remote control

Observe and interact with any instance via CLI or API socket.

### Screenshot

```bash
# Save as PNG file
cockpit-cli --instance my-dev screenshot --raw > /tmp/debug.png

# Get base64 JSON (for programmatic use)
cockpit-cli --instance my-dev screenshot | jq -r '.image' | base64 -d > shot.png
```

Screenshots capture the full BrowserWindow at native resolution. For hidden windows that were never shown, the handler briefly shows the window off-screen to force a paint, then re-hides it.

### UI state

```bash
cockpit-cli --instance my-dev ui-state | jq .
```

Returns:
```json
{
  "type": "ui-state",
  "activeSessionId": "e196e609-...",
  "sessions": [
    {
      "sessionId": "e196e609-...",
      "status": "fresh",
      "project": "my-project",
      "cwd": "/Users/me/projects/my-project",
      "origin": "pool",
      "poolStatus": "fresh"
    }
  ]
}
```

This reflects the **renderer's** view — what's visible in the sidebar, which session is selected. Compare with `get-sessions` which queries from the main process.

### Session selection

```bash
# Switch active session (sidebar + terminal + editor update)
cockpit-cli --instance my-dev session-select <sessionId>
```

Fire-and-forget — the UI updates asynchronously.

### Full workflow example

```bash
# 1. Launch hidden instance
cd .wt/my-feature && npm run dev:hidden

# 2. Init pool with 2 slots
cockpit-cli --instance my-feature pool init 2

# 3. Wait for sessions to be ready
sleep 10

# 4. Send a prompt
cockpit-cli --instance my-feature start "fix the login bug" --block

# 5. Check what the UI looks like
cockpit-cli --instance my-feature screenshot --raw > /tmp/result.png

# 6. Read the result
cockpit-cli --instance my-feature result @0

# 7. Clean up
cockpit-cli --instance my-feature pool destroy
```

## Auto-rebuild (dev:watch)

`npm run dev:watch` starts a file watcher sidecar alongside the Electron process:

1. `fs.watch` monitors `src/` recursively
2. On change, debounces 300ms, then runs `npm run build`
3. The dev instance polls `dist/renderer.js` mtime every 2s
4. When the mtime changes, `app.relaunch()` restarts the main process
5. Sessions survive via the daemon — terminals reconnect on reload

Total turnaround: edit a file → app restarts in ~2 seconds.

## Lifecycle

### What happens on quit

- **Dev instances** auto-destroy their pool on quit (daemon stays alive briefly for cleanup)
- **Base instance** leaves the daemon and pool alive — terminals persist across restarts
- **Relaunch** (`Cmd+Shift+R` or `cockpit-cli relaunch`) skips pool destroy — sessions survive

### Stale processes

`app.relaunch()` spawns a new process, but parent shell wrappers may linger. Worktree deletion doesn't kill associated instances.

**Kill a specific worktree's instance:**
```bash
cd .wt/my-feature
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE)
lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | \
  grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null
```

**Clean up stale dev state dirs:**
```bash
ls ~/.open-cockpit-dev/
# Remove dirs for instances you no longer need
rm -rf ~/.open-cockpit-dev/old-feature/
```

## Daemon stale detection

When the daemon source code (`pty-daemon.js`, `platform.js`, `secure-fs.js`) is newer than the running daemon process, the app shows a "Daemon code updated" banner. Click "Restart daemon" to apply — this kills all terminal connections (sessions survive, but terminals must reconnect).

The daemon restart is also available via:
- Command palette: "Restart Daemon"
- CLI: `cockpit-cli --instance my-dev` then use the `restart-daemon` IPC

## Comparison with base instance

| Feature | Base (`npm start`) | Dev (`npm run dev`) |
|---------|-------------------|---------------------|
| State dir | `~/.open-cockpit/` | `~/.open-cockpit-dev/<name>/` |
| Auto-updater | Active | Disabled |
| Pool on quit | Preserved | Destroyed |
| Build polling | No | Yes (2s interval) |
| `--hidden` | Not supported | Supported |
| Window title | "Open Cockpit" | "Open Cockpit [name]" |
