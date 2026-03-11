# Programmatic API

Unix socket API at `~/.open-cockpit/api.sock` for external process control. Protocol: newline-delimited JSON (same as PTY daemon).

## CLI Quick Reference

The CLI (`bin/cockpit-cli`) provides both high-level agent-friendly commands and low-level API access. It auto-augments `PATH` at startup (probing `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.nvm`) so it works from restricted shell environments like Claude Code's Bash tool.

### Targeting sessions

Most commands accept a `<target>` in three formats:

| Format | Example | Description |
|--------|---------|-------------|
| Full UUID | `2947bf12-d307-...` | Exact session ID |
| Prefix | `2947b` | Auto-resolves if unique match |
| `@N` | `@0`, `@3` | Pool slot index |

### Observing agents

```bash
cockpit-cli ls                          # List live sessions (table)
cockpit-cli ls --processing             # Filter: only processing sessions
cockpit-cli ls --idle                   # Filter: only idle sessions
cockpit-cli ls --all                    # Include archived sessions
cockpit-cli ls --json                   # Raw JSON output

cockpit-cli screen @2                   # See slot 2's terminal (ANSI-stripped)
cockpit-cli screen 2947b --raw          # Raw terminal with ANSI codes
cockpit-cli watch @2                    # Follow output in real-time (Ctrl+C to stop)
cockpit-cli watch 2947b 2               # Poll every 2 seconds

cockpit-cli log 2947b                   # Last 20 conversation turns
cockpit-cli log @1 50                   # Last 50 turns

cockpit-cli intention 2947b             # Read intention file
cockpit-cli intention 2947b "new text"  # Write intention file
```

### Interacting with agents

```bash
# High-level (handles timing automatically)
cockpit-cli followup @1 "add error handling"        # Send prompt to idle session
cockpit-cli followup 2947b "fix the bug" --block    # Send + wait for result
cockpit-cli followup @1 "respond" --force           # Send even if not idle

# Low-level keystrokes
cockpit-cli type @1 'hello\r'                       # Type text (interprets escapes)
cockpit-cli key @0 enter                            # Send Enter key
cockpit-cli key @0 ctrl-c                           # Send Ctrl+C
cockpit-cli key @0 escape                           # Send Escape
# Available keys: enter, escape, ctrl-c, ctrl-d, ctrl-u, ctrl-l,
#   ctrl-a, ctrl-e, ctrl-z, tab, backspace, up, down, left, right
```

### Session lifecycle

```bash
cockpit-cli start "fix the login bug"               # Start new session
cockpit-cli start "fix the bug" --block              # Start + wait for result
cockpit-cli followup <target> "also add tests"        # Follow up on idle session
cockpit-cli resume <target>                           # Resume offloaded session
cockpit-cli wait <target>                             # Wait for session to finish
cockpit-cli wait                                     # Wait for any session
cockpit-cli capture <target>                          # Live terminal content (raw)
cockpit-cli result <target>                           # Output (errors if running)
cockpit-cli input <target> "y"                        # Send raw input
cockpit-cli clean                                    # Offload finished sessions
cockpit-cli pin <target> [seconds]                    # Prevent offloading (default 120s)
cockpit-cli unpin <target>                            # Allow offloading again
cockpit-cli stop <target>                             # Interrupt running session
cockpit-cli archive <target>                          # Archive a session
cockpit-cli unarchive <target>                        # Move archived → recent
```

### Session terminals (per-session tab access)

All `term` commands auto-detect the session when called from within a Claude session (walks PID ancestry to find `session-pids/` entry). Specify `<target>` to override.

```bash
cockpit-cli term ls                                  # List tabs (auto-detect session)
cockpit-cli term ls @2                               # List terminal tabs for slot 2
cockpit-cli term read 1                              # Read shell tab (auto-detect)
cockpit-cli term read @2 1                           # Read shell tab content
cockpit-cli term write 1 'npm test\r'                # Type into shell tab (auto-detect)
cockpit-cli term write @2 1 'npm test\r'             # Type into shell tab
cockpit-cli term key 1 ctrl-c                        # Send Ctrl+C (auto-detect)
cockpit-cli term key @2 1 ctrl-c                     # Send Ctrl+C to shell tab
cockpit-cli term watch 1                             # Follow shell tab output (auto-detect)
cockpit-cli term watch @2 1                          # Follow shell tab output
cockpit-cli term open                                # Open new shell tab (auto-detect)
cockpit-cli term open @2                             # Open new shell tab
cockpit-cli term open @2 /path/to/dir               # Open shell tab at specific dir
cockpit-cli term close 1                             # Close shell tab (auto-detect)
cockpit-cli term close @2 1                          # Close shell tab
cockpit-cli term run 1 'npm test'                    # Run command, return output (auto-detect)
cockpit-cli term run @2 1 'npm test'                 # Run command in tab 1 of slot 2
cockpit-cli term run 1 'make' --timeout 120          # Run with 120s timeout
cockpit-cli term exec 'npm test'                     # Open tab → run → output → close (auto-detect)
cockpit-cli term exec @2 'npm test'                  # Ephemeral shell in slot 2
cockpit-cli term exec 'make build' --timeout 120     # With 120s timeout
```

### Custom agents

```bash
cockpit-cli agents                                     # List available agents
cockpit-cli agent code-review --staged                 # Run a named agent
```

Agent scripts live in `~/.open-cockpit/agents/` (global) or `.open-cockpit/agents/` (project-local). See [agents docs](agents.md) for details.

### Pool management

```bash
cockpit-cli pool init 5                              # Initialize pool
cockpit-cli pool status                              # Pool health report
cockpit-cli pool resize 8                            # Resize pool
cockpit-cli pool destroy                             # Destroy pool
```

### Slot access (by index)

```bash
cockpit-cli slot read 3                              # Read terminal buffer
cockpit-cli slot write 3 "hello"                     # Write to terminal
cockpit-cli slot status 3                            # Slot details
```

### Window control

```bash
cockpit-cli show                                     # Show the window
cockpit-cli hide                                     # Hide the window
cockpit-cli screenshot                               # Capture screenshot (base64 JSON)
cockpit-cli screenshot --raw > shot.png              # Save screenshot as PNG file
cockpit-cli ui-state                                 # Get UI state (active session, session list)
cockpit-cli session-select <id>                      # Switch active session in the UI
```

These work on any instance: `cockpit-cli --dev show` (session-owned) or `cockpit-cli --instance my-dev show` (named).

### Low-level

```bash
cockpit-cli ping                                     # Health check
cockpit-cli get-sessions                             # All sessions (raw JSON)
cockpit-cli pty-list                                 # List terminals
```

Requires `jq`. Uses `socat` or falls back to `node` for socket transport.

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
| `pool-wait` | `sessionId` or `slotIndex` (optional), `timeout` (optional, ms, default 300000) | `{ type: "result", sessionId, buffer }` |
| `pool-capture` | `sessionId` or `slotIndex` | `{ type: "buffer", sessionId, slotIndex, buffer }` |
| `pool-result` | `sessionId` or `slotIndex` | `{ type: "result", sessionId, slotIndex, buffer }` -- errors if still running |
| `pool-input` | (`sessionId` or `slotIndex`), `data` | `{ type: "ok" }` |
| `pool-clean` | -- | `{ type: "cleaned", count }` |

`pool-start` acquires a fresh slot (offloads LRU idle if none available), sends the prompt, and marks the slot busy.
`pool-resume` resumes an offloaded/archived session into a fresh slot (offloads LRU idle if needed). Unarchives if needed.
`pool-followup` sends a follow-up to an idle session (errors if not idle).
`pool-wait` long-polls until the session (or any busy session if no ID) becomes idle. Accepts `slotIndex` as alternative to `sessionId` — useful for `resume` where the session ID changes.
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
| `archive-session` | `sessionId` | `{ type: "ok" }` |
| `unarchive-session` | `sessionId` | `{ type: "ok" }` |

### Session Terminal Access
| Command | Fields | Response |
|---------|--------|----------|
| `session-terminals` | `sessionId` | `{ type: "terminals", terminals: [{ termId, index, label, isTui, pid, cwd }] }` |
| `session-term-read` | `sessionId`, `tabIndex` | `{ type: "buffer", termId, buffer }` |
| `session-term-write` | `sessionId`, `tabIndex`, `data` | `{ type: "ok" }` |
| `session-term-open` | `sessionId`, `cwd` (optional) | `{ type: "spawned", termId, tabIndex }` |
| `session-term-close` | `sessionId`, `tabIndex` | `{ type: "ok" }` |
| `session-term-run` | `sessionId`, `tabIndex`, `command`, `timeout` (optional, ms, default 30000) | `{ type: "output", output, termId }` |

`session-terminals` lists all terminal tabs for a session, sorted by creation order. The `isTui` flag marks the Claude TUI tab (pool sessions only). Tab indices are stable within a call but may shift after open/close.

`session-term-open` spawns a new shell at the session's cwd (or an explicit `cwd`). `session-term-close` refuses to close the TUI tab on pool sessions.

`session-term-run` sends a command to a shell tab, polls for a shell prompt to reappear, and returns the output (everything between the command echo and the next prompt). Refuses TUI tabs. Throws on timeout with partial output.

### Window Control
| Command | Fields | Response |
|---------|--------|----------|
| `show` | -- | `{ type: "ok" }` |
| `hide` | -- | `{ type: "ok" }` |
| `screenshot` | -- | `{ type: "screenshot", image }` — `image` is base64-encoded PNG |
| `ui-state` | -- | `{ type: "ui-state", activeSessionId, sessions }` |
| `session-select` | `sessionId` | `{ type: "ok" }` |
| `relaunch` | -- | `{ type: "ok", message }` — rebuilds from source then restarts |

`screenshot` captures the BrowserWindow contents. If the window has never been shown (hidden mode), it briefly shows the window off-screen to force a paint, then re-hides it.

`ui-state` returns the renderer's view of the world: which session is selected and the full session list with status, project, cwd, origin, and pool status. Unlike `get-sessions` (which queries from the main process), this reflects what the user sees in the sidebar.

`session-select` switches the active session in the UI (sidebar highlight, terminal view, editor). Fire-and-forget — does not wait for the switch to complete.

### Terminals (low-level)
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

### Recommended approach: high-level CLI commands

The `screen`, `followup`, `key`, and `type` commands handle ANSI stripping and timing automatically:

```bash
cockpit-cli screen @2            # Clean terminal output
cockpit-cli followup @1 "do X"   # Handles timing, sends prompt safely
cockpit-cli key @0 ctrl-c        # Named keys, no escape code memorization
```

### Low-level: raw terminal I/O

For direct terminal access, use `slot write` / `slot read` or the pool-level equivalents:

```bash
cockpit-cli slot write 3 'hello\r'    # Type text + Enter
cockpit-cli slot write 3 '\x1b'       # Send Escape key
```

**Timing matters:** The Claude TUI processes input asynchronously. If you send Enter (`\r`) before the TUI has rendered its prompt, the keystroke may be lost or misinterpreted. The app's internal `sendCommandToTerminal()` handles this by:
1. Sending Escape (clear any partial state)
2. Sending Ctrl-U (clear input line)
3. Typing the command text
4. Polling the buffer until the text appears
5. Only then sending Enter

For external tooling, either use `pool-start`/`pool-followup`/`prompt` (which handle timing automatically) or implement your own buffer polling between writes.

## Validation

- `sessionId` must match `/^[a-f0-9-]+$/i` (prevents path traversal)
- `slotIndex` must be a finite number
- `termId` must be a finite number
- Errors return `{ type: "error", error: "message" }`

## Behavior Notes

### Idle detection timing

The app trusts idle signal files directly — there is no mtime comparison between the transcript and the signal. However, `pool-wait` polls session status at intervals, so there may be a brief delay (up to a few seconds) between a session completing and `pool-wait` returning.

### Daemon write safety (`daemonSendSafe`)

Write operations routed through the PTY daemon (`pool-input`, `slot-write`, `session-term-write`, `pty-write`, trust prompt acceptance) use a safe wrapper that returns `null` instead of throwing when the daemon is disconnected. Callers should not assume these writes always succeed — the session may have exited or the daemon may have restarted.

### Auto-archiving dead sessions

Dead sessions are automatically archived during session discovery. Sessions with an intention heading get archived (meta.json saved with `archived: true`). Sessions with no intention and no snapshot are silently discarded. Archived sessions without a snapshot (e.g. those that died before offloading) will not restore conversation context on `pool-resume` — only the intention and metadata are preserved.

### `pool-clean` behavior

`pool-clean` offloads all idle sessions (creates a snapshot + sends `/clear`) and then archives them. It does not merely mark slots as available — it performs a full offload cycle for each idle session before archiving. The returned `count` reflects the number of sessions offloaded and archived.

## Security

Socket permissions are set to `0600` (owner-only). Socket is cleaned up on app quit and on startup (stale socket removal).
