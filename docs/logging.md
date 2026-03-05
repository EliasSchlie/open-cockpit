# Logging

## Philosophy

Open Cockpit logs **anomalies, not normal operations**. The log file should be quiet when everything works — if you see entries, something needs attention.

What gets logged:
- **Failures** — catch blocks that swallow errors (parse failures, file I/O, process kills)
- **Fallbacks** — when the primary path fails and a backup is used (e.g., daemon kill → PID kill)
- **Stale state** — sessions stuck in unexpected states (stale processing detection)
- **Disconnections** — daemon socket closes with pending requests
- **Timeouts** — session ID polls that never resolve

What does NOT get logged:
- Normal session lifecycle transitions
- Routine file reads/writes
- Expected conditions (file doesn't exist yet, process already exited)

## Log file

```
~/.open-cockpit/logs/open-cockpit.log
```

- Rotated at 5 MB (previous file kept as `open-cockpit.log.1`)
- One line per entry, format: `<ISO timestamp> [<LEVEL>] [<category>] <message> {context}`
- Levels: `INFO`, `WARN`, `ERROR`

Example:
```
2026-03-05T14:32:01.123Z [WARN] [main] Daemon kill failed, falling back to PID kill {"termId":3,"pid":12345,"err":"Daemon disconnected"}
2026-03-05T14:32:01.456Z [WARN] [main] Stale processing detected — idle signal hook may have failed {"sessionId":"abc-123","staleSec":312}
```

## Categories

| Category | Source file | What it covers |
|----------|-----------|----------------|
| `main` | `src/main.js` | Session discovery, pool ops, daemon communication, offload/archive |
| `daemon` | `src/pty-daemon.js` | Terminal process management, socket handling, cleanup |
| `api` | `src/api-server.js` | External API socket, parse errors |

## Usage

```javascript
const log = require("./logger")("category");

log.warn("descriptive message", { key: "value", err: err.message });
log.error("critical failure", { sessionId, err: err.message });
log.info("noteworthy event", { details });
```

Always pass `err.message` (not the full error object) in context for clean serialization.

## Checking logs

```bash
# Recent warnings/errors
tail -50 ~/.open-cockpit/logs/open-cockpit.log

# Filter by category
grep '\[daemon\]' ~/.open-cockpit/logs/open-cockpit.log

# Filter by level
grep '\[ERROR\]' ~/.open-cockpit/logs/open-cockpit.log

# Stale processing events
grep 'Stale processing' ~/.open-cockpit/logs/open-cockpit.log
```

## Adding new log points

When adding logging to new code:

1. Only log when something is **wrong or unexpected** — not on the happy path
2. Use `WARN` for recoverable issues, `ERROR` for things that need manual intervention
3. Include enough context to diagnose without reading source code (session ID, PID, term ID, error message)
4. For `ENOENT`/`ESRCH` errors (file/process doesn't exist), skip logging — these are expected race conditions
