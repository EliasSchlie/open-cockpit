---
name: cockpit-terminals
description: Use when the user should see terminal output live, when you need a persistent shell (SSH, virtualenvs), or when collaborating in a shared terminal.
---

# cockpit-terminals

Your session has **terminal tabs** in the Open Cockpit sidebar. Tab 0 is the Claude TUI (you) — only shell tabs (1+) accept commands. Fresh sessions may only have tab 0; `term open` or `term exec` creates a shell tab.

## Examples

```bash
# Run a command in an existing shell tab, get clean output
cockpit-cli term run 1 'git status'

# One-shot: opens ephemeral tab → runs → returns output → closes
cockpit-cli term exec 'npm test'

# Read last 15 lines of a tab (always use --tail to avoid flooding context)
cockpit-cli term read 1 --tail 15

# Wait for a long command to finish, then get recent output
cockpit-cli term read 1 --wait 'Build complete' --timeout 120 --tail 20
```

## Command Reference

| Subcommand | Description |
|------------|-------------|
| `run <tab> 'cmd' [--timeout N]` | Run command, return clean output. Default 30s — set higher for slow commands. Errors on timeout. |
| `exec 'cmd' [--timeout N]` | Like `run` but opens an ephemeral tab (auto-closes after). |
| `read <tab> --tail N` | Last N lines of buffer (ANSI-stripped). **Always use `--tail`** — raw `read` dumps the entire scrollback. |
| `read <tab> --wait PATTERN [--timeout N]` | Poll until regex matches (default 30s). Combine with `--tail`. |
| `write <tab> 'text\r'` | Type into terminal (`\r` = Enter). For interactive programs or when `run` can't detect completion. |
| `key <tab> <keyname>` | Send a key: `ctrl-c`, `ctrl-d`, `ctrl-l`, `ctrl-z`, `enter`, `escape`, `tab`, `up`, `down`, `left`, `right`, `backspace` |
| `ls` | List tabs (index, label, TUI flag) |
| `open [/path]` | New persistent shell tab |
| `close <tab>` | Close a shell tab |
| `watch <tab>` | Stream output live (ctrl-c to stop) |

## Troubleshooting

**`cockpit-cli` not found:** Use full path `~/.open-cockpit/bin/cockpit-cli`.

**API socket not found / ENOENT:** Open Cockpit isn't running. Ask the user to restart it — terminals survive restarts.
