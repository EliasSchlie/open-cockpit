# Debugging Sessions

## Inspecting sessions

```bash
cockpit-cli ls                    # list all live sessions with status
cockpit-cli ls --processing       # filter by status (--idle, --fresh)
cockpit-cli ls --json             # machine-readable output
cockpit-cli screen "$id"          # current terminal screen (ANSI-stripped)
cockpit-cli log "$id"             # last 20 conversation turns from transcript
cockpit-cli log "$id" 5           # last 5 turns
```

## Addressing by slot index

Sessions can also be addressed by pool slot index with `@N` prefix (e.g. `@0`, `@3`). Useful when debugging specific slots or when you don't have the session ID:

```bash
cockpit-cli screen @0             # check what slot 0 is showing
cockpit-cli ls                    # find slot numbers in the SLOT column
```

Session IDs and ID prefixes also work everywhere (e.g. `cockpit-cli screen 2947b`).

## Pool health

```bash
cockpit-cli pool status           # slot states, session mappings, health
```

## Common issues

**"Session is fresh, expected idle"** — you used `prompt` or `followup` on a session that hasn't been activated yet. Use `start` to send the first prompt to a fresh session.

**No output from `result`** — session is still processing. Use `wait "$id"` to block until it finishes, or `capture "$id"` to see live terminal state.

**Session shows "dead"** — the Claude process exited. Dead sessions are auto-restarted by pool reconciliation (runs every 30s). Check `cockpit-cli pool status` for details.
