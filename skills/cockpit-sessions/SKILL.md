---
name: cockpit-sessions
description: Use when needing to run Claude instances in parallel or in sequence — fire-and-forget tasks, multi-turn conversations, or any headless Claude work.
---

# cockpit-sessions

A **session-oriented pool** of persistent Claude TUI slots managed by Open Cockpit. Solves a fundamental problem: launching a new `claude` process while another Claude session has a Bash tool call in flight silently destroys that call's output. The pool pre-starts sessions and reuses them — `start`, `followup`, and `wait` never launch new `claude` processes.

**Shared pool:** Both the user and Claude sessions share the same pool. Sessions are tracked with parent-child relationships so the UI can nest child sessions under their parent.

**Output parsing:** Use `-v` / `--verbosity` to filter output. Levels: `response` (final model answer only), `conversation` (all prompts + responses), `full` (terminal buffer, ANSI-stripped), `raw` (default, unfiltered). Example: `cockpit-cli -v response wait "$id"`

## Quick Start

```bash
# Fire-and-forget
id=$(cockpit-cli start "refactor auth module")

# Blocking — wait for result (parsed to just the response)
result=$(cockpit-cli -v response start "summarize this file" --block)

# Multi-turn
id=$(cockpit-cli start "analyze the codebase")
cockpit-cli wait "$id"
cockpit-cli followup "$id" "now suggest improvements" --block

# See what a running session is doing
cockpit-cli capture "$id"

# Parallel work
id1=$(cockpit-cli start "task one")
id2=$(cockpit-cli start "task two")
cockpit-cli wait "$id1"
cockpit-cli wait "$id2"
```

## CLI

Run `cockpit-cli --help` for full CLI reference.

## Output Contract

| Command | stdout | stderr | blocks? |
|---------|--------|--------|---------|
| `start` | session ID | — | no |
| `start --block` | output (filtered by `-v`) | session ID | yes |
| `followup` | session ID | — | no |
| `followup --block` | output (filtered by `-v`) | session ID | yes |
| `capture` | terminal content | — | no |
| `result` | output (filtered by `-v`) | — | no (errors if running) |
| `wait <id>` | output (filtered by `-v`) | — | yes |
| `wait` (no ID) | result of first to finish | — | yes |

## Session Lifecycle

```
fresh → processing → idle → offloaded (graceful /clear)
                       ↓
                    archived
```

- **fresh** — pool slot ready, no user input yet
- **processing** — Claude is working on it
- **idle** — done, session still loaded, ready for `followup`
- **offloaded** — slot reclaimed; terminal snapshot stored, session can be resumed

## Multi-Turn Conversations

`followup` resumes a finished session — conversation history is preserved.

- Only works on **idle** sessions. Errors if still processing (use `wait` first).
- If the session was offloaded, use `resume` to bring it back first.
- Reuses the existing session ID (same conversation).

## Blocking vs Non-Blocking

**Non-blocking (default):** `start` prints the ID and returns immediately. Use `wait` or `capture` to observe progress.

**`--block`:** waits inline, prints output to stdout. ID goes to stderr.

## Best Practices

**Prefer fire-and-forget + explicit wait** over `--block` for parallel work.

**Use `followup` for multi-turn, not `input`.** `input` is for raw terminal interaction (menus, interactive prompts).

**Clean completed sessions** to free slots: `cockpit-cli clean`

**Pin sessions** during interactive key sequences: `cockpit-cli pin "$id" 300` (prevents the pool from offloading it). Unpin when done.

**Always overprovision.** Sub-agents, other Claude instances, and hooks all consume slots. A pool that looks big enough at launch saturates quickly once nested work kicks in.

## Sub-Skills

| Situation | File |
|-----------|------|
| Interactive key sequences, pinning | [interactive-sessions.md](interactive-sessions.md) |
| Pool setup, resizing | [pool-management.md](pool-management.md) |
