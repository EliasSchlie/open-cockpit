# Plugin Hooks

The Claude Code plugin (`hooks/`) provides four hook scripts:

## `SessionStart` → `session-pid-map.sh`

Writes the session ID to `~/.open-cockpit/session-pids/<PID>` so the app can discover active sessions and map them to their intention files.

Stale PID entries (dead processes) are cleaned up on each session start. Also deduplicates: if another alive PID maps to the same session UUID (e.g. after `/resume`), the older file is removed.

## `UserPromptSubmit` → `session-intention-intro.sh` (once per session)

Introduces Claude to the session's intention file (`~/.open-cockpit/intentions/<session_id>.md`) on the first user prompt. Uses a PID-based marker file (`~/.open-cockpit/intentions/.intro-sent/<PID>`) to fire only once per session. Stale markers from dead PIDs are cleaned up automatically.

Resolves the session ID via PID mapping (written by `session-pid-map.sh` at SessionStart). Also creates an initial snapshot for change detection (used by `intention-change-notify.sh`).

Previously this was a `SessionStart` hook, but `UserPromptSubmit` is more reliable — `SessionStart` doesn't consistently deliver output to Claude's context.

## `UserPromptSubmit` → `intention-change-notify.sh`

On every user prompt, diffs the intention file against its last known snapshot. If the user edited the file (via the Open Cockpit editor), surfaces a unified diff to Claude so it can adapt.

Resolves the session ID via the PID mapping written by `session-pid-map.sh`.

## Idle signal hooks → `idle-signal.sh`

Detects when sessions become idle (waiting for user input) or start processing. Writes signal files to `~/.open-cockpit/idle-signals/<PID>`.

**No false positives.** Idle signals must only appear when a session is truly waiting for user input. The app may trigger notifications (e.g. a bell) on idle, so a premature signal is worse than a delayed one. The `stop` trigger defers writing for a few seconds and verifies the transcript hasn't changed (which would indicate a re-prompt from another hook).

### Signal lifecycle

| Hook Event | Matcher | Action | Meaning |
|------------|---------|--------|---------|
| `Stop` | — | deferred write (stop) | Claude finished responding (verified after 3s) |
| `PreToolUse` | `AskUserQuestion\|ExitPlanMode` | write (tool) | Claude is asking for input |
| `PermissionRequest` | — | write (permission) | Waiting for permission approval |
| `PostToolUse` | — | clear | Processing resumed after tool use |
| `UserPromptSubmit` | — | clear | User submitted a prompt |
| `SessionStart` | `clear` | clear | Session was cleared (`/clear`) |

### Signal file format

```json
{"cwd": "/path/to/project", "session_id": "uuid", "transcript": "/path/to/jsonl", "ts": 1234567890, "trigger": "stop"}
```

### How the app uses signals

- **Has signal + transcript mtime > signal mtime** → processing (Stop hook re-prompted Claude)
- **Has signal + has human turns in JSONL** → idle (ready for input)
- **Has signal + no human turns** → fresh (never used)
- **No signal + alive** → processing
- **Not alive** → dead
