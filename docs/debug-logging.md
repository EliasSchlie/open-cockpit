# Debug Logging

Persistent file-based logging for both main and renderer processes. Logs write to `~/.open-cockpit/debug.log`.

## Usage

### Main process

```js
debugLog("main", "message", optionalData);
```

### Renderer process

```js
debugLog("tag", "message", optionalData);
// Automatically prefixed as "renderer:tag" in the log file
```

The renderer helper sends logs to main via IPC (`debug-log` channel). It's safe to call before the API is ready (uses optional chaining).

## Log format

```
2026-03-05T14:23:01.123Z [renderer:session] select abc123 gen=5 origin=pool
2026-03-05T14:23:01.456Z [main] starting (dev) pid=12345
```

Each line: ISO timestamp, tag in brackets, message. Non-string arguments are JSON-serialized.

## Rotation

Log rotates at 2 MB. Previous log is kept as `debug.log.1`. Only one generation of backup is retained.

## Current instrumentation

### Renderer (`renderer:*`)

| Tag | What's logged |
|-----|--------------|
| `renderer:session` | Session selection, race-condition aborts (with generation counter) |
| `renderer:pool` | Offload attempts, fresh-slot polling, poll timeouts, resume failures |
| `renderer:term` | Terminal attach failures |
| `renderer:editor` | Intention save failures |
| `renderer:startup` | PTY reconnection count, orphaned PTY detach |

### Main (`main`)

| What's logged |
|--------------|
| App startup (dev/prod mode, PID) |
| Pool slot init/resume failures (termId, pid, reason) |
| Pool slot tracking errors (termId, pid, error message) |
| Trust prompt detection failures (termId) |

## Reading logs

```bash
# Tail live
tail -f ~/.open-cockpit/debug.log

# Search for session race aborts
grep "race abort" ~/.open-cockpit/debug.log

# Search for pool issues
grep "renderer:pool" ~/.open-cockpit/debug.log
```

## Adding new log points

1. **Renderer**: Call `debugLog("tag", "message", ...args)` — the helper is available globally in `renderer.js`
2. **Main**: Call `debugLog("tag", "message", ...args)` — the function is defined at the top of `main.js`
3. Use descriptive tags: `session`, `pool`, `term`, `editor`, `startup`, `api`, etc.
4. Include identifiers (session IDs, term IDs, generation counters) for traceability
5. Log at decision points, not on every event — keep volume reasonable
