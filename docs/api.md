# Programmatic API

Unix socket API at `~/.open-cockpit/api.sock` for external process control. Protocol: newline-delimited JSON (same as PTY daemon).

## CLI Helper

```bash
bin/cockpit-cli ping
bin/cockpit-cli get-sessions
bin/cockpit-cli pool-init 5
bin/cockpit-cli pty-list
```

Requires `socat` or falls back to `node`.

## Protocol

Send JSON with `type` and optional `id`. Response echoes `id` back.

```
→ {"type":"ping","id":1}
← {"type":"pong","id":1}
```

## Commands

### Meta
| Command | Fields | Response |
|---------|--------|----------|
| `ping` | — | `{ type: "pong" }` |

### Pool
| Command | Fields | Response |
|---------|--------|----------|
| `pool-init` | `size` (optional, default 5) | `{ type: "pool", pool }` |
| `pool-resize` | `size` (required) | `{ type: "pool", pool }` |
| `pool-health` | — | `{ type: "health", health }` |
| `pool-read` | — | `{ type: "pool", pool }` |
| `pool-destroy` | — | `{ type: "ok" }` |

### Sessions
| Command | Fields | Response |
|---------|--------|----------|
| `get-sessions` | — | `{ type: "sessions", sessions }` |
| `read-intention` | `sessionId` | `{ type: "intention", content }` |
| `write-intention` | `sessionId`, `content` | `{ type: "ok" }` |

### Terminals
| Command | Fields | Response |
|---------|--------|----------|
| `pty-list` | — | `{ type: "ptys", ptys }` |
| `pty-write` | `termId`, `data` | `{ type: "ok" }` |
| `pty-spawn` | `cwd`, `cmd`, `args` | `{ type: "spawned", termId, pid }` |
| `pty-kill` | `termId` | `{ type: "ok" }` |
| `pty-read` | `termId` | `{ type: "buffer", buffer }` |

## Validation

- `sessionId` must match `/^[a-f0-9-]+$/i` (prevents path traversal)
- `termId` must be a finite number
- Errors return `{ type: "error", error: "message" }`

## Security

Socket permissions are set to `0600` (owner-only). Socket is cleaned up on app quit and on startup (stale socket removal).
