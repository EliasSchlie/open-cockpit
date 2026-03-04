# PTY Daemon

Terminals are managed by a standalone daemon process (`src/pty-daemon.js`) that runs independently of any Electron window. This means:

- Terminals survive app restarts, Cmd+R reloads, and dev instance cycling
- Multiple Electron instances (dev + production) can display the same terminals simultaneously
- Input from any attached client goes to the same PTY

## Architecture

```
Electron (any instance)          PTY Daemon
┌──────────────┐         ┌──────────────────┐
│  renderer.js  │         │  pty-daemon.js    │
│  (xterm.js)   │◄──IPC──►│                  │
│               │         │  node-pty procs   │
│  main.js      │◄─socket─►│  output buffers   │
│  (client)     │         │  session mapping  │
└──────────────┘         └──────────────────┘
```

## Socket protocol

Unix domain socket at `~/.open-cockpit/pty-daemon.sock`. Newline-delimited JSON.

### Client → Daemon

| Command | Fields | Response |
|---------|--------|----------|
| `spawn` | `cwd, cmd, args, sessionId` | `spawned` with `termId, pid` |
| `write` | `termId, data` | (none) |
| `resize` | `termId, cols, rows` | (none) |
| `kill` | `termId` | `killed` |
| `list` | — | `list-result` with `ptys[]` |
| `attach` | `termId` | `attached` + `replay` with buffered output |
| `detach` | `termId` | (none) |
| `set-session` | `termId, sessionId` | `session-set` |
| `ping` | — | `pong` |

### Daemon → Client (push events)

| Event | Fields | When |
|-------|--------|------|
| `data` | `termId, data` | PTY output (only to attached clients) |
| `exit` | `termId, exitCode` | PTY process exited |
| `replay` | `termId, data` | Buffered output sent on attach |

## Command validation

The `spawn` command validates the `cmd` field:
- Known shells (`/bin/zsh`, `/bin/bash`, `/bin/sh`) are always allowed
- Absolute paths to executable files are allowed (verified via `fs.accessSync`)
- Relative or non-executable paths are rejected; falls back to `$SHELL`

The daemon also augments `PATH` with `~/.claude/local/bin`, `~/.local/bin`, and `/usr/local/bin` so spawned processes can find tools like `claude`.

## Lifecycle

- **Auto-start**: Electron's main process spawns the daemon if not running
- **PID file**: `~/.open-cockpit/pty-daemon.pid`
- **Auto-exit**: 30 minutes after last terminal closes and last client disconnects
- **Signals**: SIGTERM/SIGINT → clean shutdown (kills all PTYs, removes socket)

## Output buffering

Each terminal buffers the last 100KB of output. On `attach`, this buffer is replayed to the client, restoring terminal content after app restart.

## Debugging

```bash
# Check if daemon is running
cat ~/.open-cockpit/pty-daemon.pid && kill -0 $(cat ~/.open-cockpit/pty-daemon.pid) && echo "alive" || echo "dead"

# View daemon logs (stderr)
# Daemon runs detached with stdio ignored — redirect in pty-daemon.js if needed

# List active terminals via socat
echo '{"type":"list","id":1}' | socat - UNIX-CONNECT:$HOME/.open-cockpit/pty-daemon.sock

# Kill daemon manually
kill $(cat ~/.open-cockpit/pty-daemon.pid)
```
