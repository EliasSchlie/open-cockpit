# Pool Management

## Commands

```bash
cockpit-cli pool init           # start 5-slot pool
cockpit-cli pool init 8         # explicit size — always overprovision
cockpit-cli pool status         # inspect slots, health
cockpit-cli pool resize 8       # grow (adds slots)
cockpit-cli pool resize 3       # shrink (offloads idle slots gracefully)
cockpit-cli pool destroy        # kill everything
```

Pool state lives in `~/.open-cockpit/pool.json`.

**Shared pool:** The pool is shared between the user (via Open Cockpit UI) and Claude sessions (via `cockpit-cli`). Both see the same sessions.

> **Pool init and resize run `claude` to create new slots.** This may cause any currently-running Bash tool calls from other Claude sessions to lose output. Plan init before work starts or during idle periods.

## Verbosity Levels

Use `-v` before any output command to filter what you see:

| Level | What you get |
|-------|-------------|
| `raw` (default) | Terminal buffer as-is (ANSI codes included) |
| `full` | Terminal buffer with ANSI stripped |
| `conversation` | All user + assistant messages from JSONL transcript |
| `response` | Last assistant message only (cleanest for programmatic use) |

```bash
cockpit-cli -v response result "$id"
cockpit-cli -v conversation wait "$id"
cockpit-cli -v full capture "$id"
```
