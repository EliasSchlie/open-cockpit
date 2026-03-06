---
name: cockpit-terminals
description: Use when needing to run shell commands, check server output, or do any work outside the Claude TUI — persistent terminal tabs shared with the user in the Open Cockpit sidebar.
---

# cockpit-terminals

Your session has **terminal tabs** visible in the Open Cockpit sidebar. Tab 0 is the Claude TUI (you). Additional tabs are persistent shells — the user can see, type into, and read them in real-time, and so can you.

The CLI path is `~/.open-cockpit/bin/cockpit-cli`. Do NOT create a shell alias — aliases don't persist across Bash tool calls. All examples below use the full path.

All `term` commands auto-detect your session ID — no target argument needed.

## Key concepts

- **Tab 0 is your TUI** — you cannot `run` or `exec` on it. Only shell tabs (1+) accept commands.
- **Fresh sessions may only have tab 0.** Use `term open` or `term exec` (which creates an ephemeral tab automatically).
- **`term run`** returns clean output (command result only). Prefer it for getting data.
- **`term exec`** output includes shell prompts and ANSI artifacts — use when you don't need to parse the output.

## Quick Start

```bash
# One-shot: run a command, get output, tab auto-closes
~/.open-cockpit/bin/cockpit-cli term exec 'npm test'

# Run in an existing shell tab (preserves state, env vars, cwd)
~/.open-cockpit/bin/cockpit-cli term run 1 'git status'

# Open a new persistent shell tab
~/.open-cockpit/bin/cockpit-cli term open

# See what tabs you have
~/.open-cockpit/bin/cockpit-cli term ls
```

## Choosing the Right Command

| Command | Use when |
|---------|----------|
| `term exec 'cmd'` | Quick one-shot — opens ephemeral tab, runs, returns output, closes |
| `term run <tab> 'cmd'` | Command needs an existing shell's state (env, cwd, history) |
| `term write <tab> 'text'` | Interactive programs, menus, or partial input (no automatic output capture) |
| `term read <tab>` | Checking what the user or a process wrote to the terminal |

## Command Reference

All commands below follow the pattern `~/.open-cockpit/bin/cockpit-cli term <subcommand> [args]`.

| Subcommand | Description |
|------------|-------------|
| `ls` | List tabs (index, label, TUI flag) |
| `read <tab>` | Read terminal buffer |
| `write <tab> 'text\r'` | Type into terminal (`\r` = Enter) |
| `key <tab> ctrl-c` | Send named key |
| `watch <tab>` | Follow output live (Ctrl+C to stop) |
| `open [/path]` | New shell tab at session cwd or given path |
| `close <tab>` | Close tab (can't close TUI tab) |
| `run <tab> 'cmd'` | Run command, return output when done (default 30s timeout) |
| `run <tab> 'cmd' --timeout 120` | With custom timeout in seconds |
| `exec 'cmd'` | Ephemeral: open tab, run, return output, close |
| `exec 'cmd' --timeout 120` | With custom timeout |

Available keys: `enter`, `escape`, `ctrl-c`, `ctrl-d`, `ctrl-u`, `ctrl-l`, `ctrl-a`, `ctrl-e`, `ctrl-z`, `tab`, `backspace`, `up`, `down`, `left`, `right`.

## When to Use Terminals vs Bash Tool

**Use terminals when:**
- The user should see what's happening (deployments, logs, long-running processes)
- You need a persistent shell (SSH sessions, virtualenvs, env vars that accumulate)
- You're collaborating — the user might type in the same terminal

**Use the Bash tool when:**
- You just need command output for your own reasoning
- The operation is quick and self-contained

## Troubleshooting

If commands fail with `ENOENT` or "API socket not found", the Open Cockpit app lost its API socket or isn't running. Ask the user to restart Open Cockpit — terminals survive restarts (the PTY daemon keeps them alive).
