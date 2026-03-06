---
name: cockpit-terminals
description: Use when needing to run shell commands, check server output, or do any work outside the Claude TUI — persistent terminal tabs shared with the user in the Open Cockpit sidebar.
---

# cockpit-terminals

Your session has **terminal tabs** visible in the Open Cockpit sidebar. Tab 0 is the Claude TUI (you). Additional tabs are persistent shells — the user can see, type into, and read them in real-time, and so can you.

All `cockpit-cli term` commands auto-detect your session ID — no target argument needed.

## Quick Start

```bash
# One-shot: run a command, get output, tab auto-closes
cockpit-cli term exec 'npm test'

# Run in an existing shell tab (preserves state, env vars, cwd)
cockpit-cli term run 1 'git status'

# Open a new persistent shell tab
cockpit-cli term open

# See what tabs you have
cockpit-cli term ls
```

## Choosing the Right Command

| Command | Use when |
|---------|----------|
| `term exec 'cmd'` | Quick one-shot — opens ephemeral tab, runs, returns output, closes |
| `term run <tab> 'cmd'` | Command needs an existing shell's state (env, cwd, history) |
| `term write <tab> 'text'` | Interactive programs, menus, or partial input (no automatic output capture) |
| `term read <tab>` | Checking what the user or a process wrote to the terminal |

## Command Reference

```bash
cockpit-cli term ls                      # List tabs (index, label, TUI flag)
cockpit-cli term read <tab>              # Read terminal buffer
cockpit-cli term write <tab> 'text\r'    # Type into terminal (\r = Enter)
cockpit-cli term key <tab> ctrl-c        # Send named key
cockpit-cli term watch <tab>             # Follow output live (Ctrl+C to stop)
cockpit-cli term open                    # New shell at session cwd
cockpit-cli term open /path/to/dir       # New shell at specific directory
cockpit-cli term close <tab>             # Close tab (can't close TUI tab)
cockpit-cli term run <tab> 'cmd'         # Run command, return output when done
cockpit-cli term run <tab> 'cmd' --timeout 120  # With timeout (default 30s)
cockpit-cli term exec 'cmd'              # Ephemeral: open → run → output → close
cockpit-cli term exec 'cmd' --timeout 120
```

Available keys: `enter`, `escape`, `ctrl-c`, `ctrl-d`, `ctrl-u`, `ctrl-l`, `ctrl-a`, `ctrl-e`, `ctrl-z`, `tab`, `backspace`, `up`, `down`, `left`, `right`.

## When to Use Terminals vs Bash Tool

**Use terminals when:**
- The user should see what's happening (deployments, logs, long-running processes)
- You need a persistent shell (SSH sessions, virtualenvs, env vars that accumulate)
- You're collaborating — the user might type in the same terminal

**Use the Bash tool when:**
- You just need command output for your own reasoning
- The operation is quick and self-contained
