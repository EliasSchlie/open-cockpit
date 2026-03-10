---
name: cockpit-sessions
description: Use when needing to run Claude instances in parallel or in sequence — fire-and-forget tasks, multi-turn conversations, or any headless Claude work.
---

# cockpit-sessions

Send prompts to other Claude sessions through a shared pool. The pool pre-starts sessions so `start` never launches a new `claude` process (which would destroy any in-flight Bash tool call output).

Requires Open Cockpit running with an active pool. `cockpit-cli` auto-augments `PATH` so it works from restricted shells — just call it directly, no PATH setup needed.

If `cockpit-cli start` fails with "socket not found", the app isn't running. If it fails with "no fresh slots", the pool is full — run `cockpit-cli clean` or wait for sessions to finish.

## Sending a prompt

```bash
# Auto-claims a fresh session, returns its ID
id=$(cockpit-cli start "refactor auth module")
```

That's it. A fresh pool session is automatically assigned. Use the returned session ID for all follow-up operations.

## Common patterns

```bash
# Blocking — wait inline for the response
result=$(cockpit-cli -v response start "summarize this file" --block)

# Multi-turn conversation
id=$(cockpit-cli start "analyze the codebase")
cockpit-cli wait "$id"
cockpit-cli followup "$id" "now suggest improvements" --block

# Parallel work
id1=$(cockpit-cli start "task one")
id2=$(cockpit-cli start "task two")
cockpit-cli wait "$id1"
cockpit-cli wait "$id2"

# Check what a running session is doing
cockpit-cli capture "$id"
```

## Output filtering

Use `-v` before any output command to control what you get back:

| Level | What you get |
|-------|-------------|
| `raw` (default) | Terminal buffer as-is (ANSI codes included) |
| `full` | Terminal buffer with ANSI stripped |
| `conversation` | All user + assistant messages from transcript |
| `response` | Last assistant message only (cleanest for programmatic use) |

```bash
cockpit-cli -v response wait "$id"
cockpit-cli -v response start "quick question" --block
```

## Output contract

| Command | stdout | stderr | blocks? |
|---------|--------|--------|---------|
| `start` | session ID | -- | no |
| `start --block` | output (filtered by `-v`) | session ID | yes |
| `followup` | session ID | -- | no |
| `followup --block` | output (filtered by `-v`) | session ID | yes |
| `capture` | terminal content | -- | no |
| `result` | output (filtered by `-v`) | -- | no (errors if running) |
| `wait <id>` | output (filtered by `-v`) | -- | yes |
| `wait` (no ID) | result of first to finish | -- | yes |

## Session lifecycle

- **fresh** -- pool session ready, no user input yet. Use `start` to claim one.
- **processing** -- Claude is working on it
- **idle** -- done, ready for `followup`
- **offloaded** -- slot reclaimed; snapshot stored, can be `resume`d

## Multi-turn conversations

`followup` sends a new prompt to a finished session -- conversation history is preserved.

- Only works on **idle** sessions. If still processing, use `wait` first.
- If offloaded, use `resume` to bring it back.

## Best practices

- **Prefer fire-and-forget + explicit `wait`** over `--block` for parallel work.
- **Use `followup` for multi-turn, not `input`.** `input` is for raw terminal interaction.
- **Clean completed sessions** to free pool capacity: `cockpit-cli clean`

## CLI reference

Run `cockpit-cli` (no args) for full CLI reference.

## Sub-skills

| Situation | File |
|-----------|------|
| Interactive key sequences, pinning | [interactive-sessions.md](interactive-sessions.md) |
| Pool setup, resizing, overprovisioning | [pool-management.md](pool-management.md) |
| Inspecting sessions, slot addressing, troubleshooting | [debugging.md](debugging.md) |
