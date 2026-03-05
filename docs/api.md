# Programmatic API

Unix socket API at `~/.open-cockpit/api.sock` for external process control. Protocol: newline-delimited JSON (same as PTY daemon).

## CLI Helper

```bash
# Session commands (sub-claude compatible)
bin/cockpit-cli start "fix the login bug"          # returns session ID
bin/cockpit-cli start "fix the login bug" --block   # waits, prints output
bin/cockpit-cli followup <id> "also add tests"      # follow up on idle session
bin/cockpit-cli wait <id>                            # wait for session to finish
bin/cockpit-cli wait                                 # wait for any session
bin/cockpit-cli capture <id>                         # live terminal content
bin/cockpit-cli result <id>                          # output (errors if running)
bin/cockpit-cli input <id> "y"                       # send raw input
bin/cockpit-cli clean                                # offload finished sessions

# Pool management
bin/cockpit-cli pool init 5
bin/cockpit-cli pool status
bin/cockpit-cli pool resize 8
bin/cockpit-cli pool destroy

# Low-level (legacy)
bin/cockpit-cli ping
bin/cockpit-cli get-sessions
bin/cockpit-cli pty-list
```

Requires `jq` for session commands. Uses `socat` or falls back to `node` for socket transport.

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

### Pool Interaction (sub-claude compatible)
| Command | Fields | Response |
|---------|--------|----------|
| `pool-start` | `prompt` | `{ type: "started", sessionId, termId, slotIndex }` |
| `pool-followup` | `sessionId`, `prompt` | `{ type: "started", sessionId, termId, slotIndex }` |
| `pool-wait` | `sessionId` (optional), `timeout` (optional, ms, default 300000) | `{ type: "result", sessionId, buffer }` |
| `pool-capture` | `sessionId` | `{ type: "buffer", sessionId, buffer }` |
| `pool-result` | `sessionId` | `{ type: "result", sessionId, buffer }` — errors if still running |
| `pool-input` | `sessionId`, `data` | `{ type: "ok" }` |
| `pool-clean` | — | `{ type: "cleaned", count }` |

`pool-start` acquires the first fresh slot, sends the prompt, and marks the slot busy.
`pool-followup` sends a follow-up to an idle session (errors if not idle).
`pool-wait` long-polls until the session (or any busy session if no ID) becomes idle.
`pool-result` returns the buffer only if the session is not running.
`pool-clean` offloads all idle sessions to free their slots.

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
