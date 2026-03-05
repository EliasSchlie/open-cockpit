# Programmatic API

Unix socket API at `~/.open-cockpit/api.sock` for external process control. Protocol: newline-delimited JSON (same as PTY daemon).

## CLI Helper

```bash
# Session commands (sub-claude compatible)
bin/cockpit-cli start "fix the login bug"          # returns session ID
bin/cockpit-cli start "fix the login bug" --block   # waits, prints output
bin/cockpit-cli resume <id>                         # resume offloaded/archived session
bin/cockpit-cli resume <id> --block                 # resume and wait for completion
bin/cockpit-cli followup <id> "also add tests"      # follow up on idle session
bin/cockpit-cli wait <id>                            # wait for session to finish
bin/cockpit-cli wait                                 # wait for any session
bin/cockpit-cli capture <id>                         # live terminal content
bin/cockpit-cli capture --slot 3                     # live terminal content by slot
bin/cockpit-cli result <id>                          # output (errors if running)
bin/cockpit-cli input <id> "y"                       # send raw input
bin/cockpit-cli input --slot 3 "y"                   # send raw input by slot
bin/cockpit-cli clean                                # offload finished sessions

# Pool management
bin/cockpit-cli pool init 5
bin/cockpit-cli pool status
bin/cockpit-cli pool resize 8
bin/cockpit-cli pool destroy

# Slot access (by index, works even without sessionId)
bin/cockpit-cli slot read 3                          # read terminal buffer
bin/cockpit-cli slot write 3 "hello"                 # write to terminal
bin/cockpit-cli slot status 3                        # slot details

# Low-level (legacy)
bin/cockpit-cli ping
bin/cockpit-cli get-sessions
bin/cockpit-cli pty-list
```

Requires `jq` for session commands. Uses `socat` or falls back to `node` for socket transport.

## Protocol

Send JSON with `type` and optional `id`. Response echoes `id` back.

```
-> {"type":"ping","id":1}
<- {"type":"pong","id":1}
```

## Commands

### Meta
| Command | Fields | Response |
|---------|--------|----------|
| `ping` | -- | `{ type: "pong" }` |

### Pool
| Command | Fields | Response |
|---------|--------|----------|
| `pool-init` | `size` (optional, default 5) | `{ type: "pool", pool }` |
| `pool-resize` | `size` (required) | `{ type: "pool", pool }` |
| `pool-health` | -- | `{ type: "health", health }` |
| `pool-read` | -- | `{ type: "pool", pool }` |
| `pool-destroy` | -- | `{ type: "ok" }` |

### Pool Interaction (sub-claude compatible)
| Command | Fields | Response |
|---------|--------|----------|
| `pool-start` | `prompt` | `{ type: "started", sessionId, termId, slotIndex }` |
| `pool-resume` | `sessionId` | `{ type: "resumed", sessionId, termId, slotIndex }` |
| `pool-followup` | `sessionId`, `prompt` | `{ type: "started", sessionId, termId, slotIndex }` |
| `pool-wait` | `sessionId` (optional), `timeout` (optional, ms, default 300000) | `{ type: "result", sessionId, buffer }` |
| `pool-capture` | `sessionId` or `slotIndex` | `{ type: "buffer", sessionId, slotIndex, buffer }` |
| `pool-result` | `sessionId` or `slotIndex` | `{ type: "result", sessionId, slotIndex, buffer }` -- errors if still running |
| `pool-input` | (`sessionId` or `slotIndex`), `data` | `{ type: "ok" }` |
| `pool-clean` | -- | `{ type: "cleaned", count }` |

`pool-start` acquires a fresh slot (offloads LRU idle if none available), sends the prompt, and marks the slot busy.
`pool-resume` resumes an offloaded/archived session into a fresh slot (offloads LRU idle if needed). Unarchives if needed.
`pool-followup` sends a follow-up to an idle session (errors if not idle).
`pool-wait` long-polls until the session (or any busy session if no ID) becomes idle.
`pool-result` returns the buffer only if the session is not running.
`pool-clean` offloads all idle sessions to free their slots.

### Slot Access (by index)

Direct slot access by pool index. Works even on error-status slots that have no sessionId -- useful for debugging stuck slots and external tooling.

| Command | Fields | Response |
|---------|--------|----------|
| `slot-read` | `slotIndex` | `{ type: "buffer", slotIndex, sessionId, buffer }` |
| `slot-write` | `slotIndex`, `data` | `{ type: "ok" }` |
| `slot-status` | `slotIndex` | `{ type: "slot", slot: { index, termId, pid, status, sessionId, healthStatus, createdAt } }` |

### Sessions
| Command | Fields | Response |
|---------|--------|----------|
| `get-sessions` | -- | `{ type: "sessions", sessions }` |
| `read-intention` | `sessionId` | `{ type: "intention", content }` |
| `write-intention` | `sessionId`, `content` | `{ type: "ok" }` |

### Terminals
| Command | Fields | Response |
|---------|--------|----------|
| `pty-list` | -- | `{ type: "ptys", ptys }` |
| `pty-write` | `termId`, `data` | `{ type: "ok" }` |
| `pty-spawn` | `cwd`, `cmd`, `args` | `{ type: "spawned", termId, pid }` |
| `pty-kill` | `termId` | `{ type: "ok" }` |
| `pty-read` | `termId` | `{ type: "buffer", buffer }` |

## Addressing Modes

There are three ways to target a terminal, at different levels of abstraction:

| Mode | When to use | Example |
|------|-------------|---------|
| **sessionId** | Normal interaction with known sessions | `{"type":"pool-capture","sessionId":"abc-123"}` |
| **slotIndex** | Debugging, error recovery, stuck slots | `{"type":"slot-read","slotIndex":8}` |
| **termId** | Low-level terminal access (bypass pool) | `{"type":"pty-read","termId":63}` |

`pool-capture`, `pool-result`, and `pool-input` accept either `sessionId` or `slotIndex`. When both are provided, `slotIndex` takes precedence.

## Interacting with Sessions Externally

External tools (including other Claude Code sessions) can observe and interact with pool sessions through the API.

### Reading terminal output

```bash
# By session ID
cockpit-cli capture <sessionId>

# By slot index (works even without sessionId)
cockpit-cli slot read 3
```

The buffer is raw terminal output with ANSI escape codes. Strip them for plain text:
```bash
cockpit-cli slot read 3 | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'
```

### Sending keystrokes

```bash
# Type text + Enter
cockpit-cli slot write 3 'hello\r'

# Send Escape key
cockpit-cli slot write 3 '\x1b'
```

**Timing matters:** The Claude TUI processes input asynchronously. If you send Enter (`\r`) before the TUI has rendered its prompt, the keystroke may be lost or misinterpreted. The app's internal `sendCommandToTerminal()` handles this by:
1. Sending Escape (clear any partial state)
2. Sending Ctrl-U (clear input line)
3. Typing the command text
4. Polling the buffer until the text appears
5. Only then sending Enter

For external tooling, either use `pool-start`/`pool-followup` (which handle timing automatically) or implement your own buffer polling between writes.

## Validation

- `sessionId` must match `/^[a-f0-9-]+$/i` (prevents path traversal)
- `slotIndex` must be a finite number
- `termId` must be a finite number
- Errors return `{ type: "error", error: "message" }`

## Security

Socket permissions are set to `0600` (owner-only). Socket is cleaned up on app quit and on startup (stale socket removal).
