# Plugin Hooks

The Claude Code plugin (`hooks/`) provides four hook scripts:

## `SessionStart` → `session-pid-map.sh`

Writes the session ID to `~/.claude/session-pids/<PID>` so the app can discover active sessions and map them to their intention files.

Stale PID entries (dead processes) are cleaned up on each session start.

## `SessionStart` → `session-intention-intro.sh`

Introduces Claude to the session's intention file (`~/.open-cockpit/intentions/<session_id>.md`). Instructs Claude to:

- Read existing intention content and resume from it
- Collaborate with the user to define the session's goal if empty
- Write a markdown title + description capturing the intent
- Keep the file updated as the goal evolves

Also creates an initial snapshot for change detection (used by the UserPromptSubmit hook).

## `UserPromptSubmit` → `intention-change-notify.sh`

On every user prompt, diffs the intention file against its last known snapshot. If the user edited the file (via the Open Cockpit editor), surfaces a unified diff to Claude so it can adapt.

Resolves the session ID via the PID mapping written by `session-pid-map.sh`.

## Idle signal hooks → `idle-signal.sh`

Detects when sessions become idle (waiting for user input) or start processing. Writes signal files to `~/.open-cockpit/idle-signals/<PID>`.

### Signal lifecycle

| Hook Event | Matcher | Action | Meaning |
|------------|---------|--------|---------|
| `Stop` | — | write (stop) | Claude finished responding |
| `PreToolUse` | `AskUserQuestion\|ExitPlanMode` | write (tool) | Claude is asking for input |
| `PermissionRequest` | — | write (permission) | Waiting for permission approval |
| `PostToolUse` | — | clear | Processing resumed after tool use |
| `UserPromptSubmit` | — | clear | User submitted a prompt |
| `SessionStart` | `clear` | clear | Session was cleared (`/clear`) |

### Block detection

The Stop hook waits 1s then checks if the JSONL transcript was modified — if so, another hook blocked and the session continued (not idle). The signal is removed.

### Sub-claude exclusion

The hook checks `SUB_CLAUDE=1` env var and exits early. Sub-claude sessions never write signals.

### Signal file format

```json
{"cwd": "/path/to/project", "session_id": "uuid", "transcript": "/path/to/jsonl", "ts": 1234567890, "trigger": "stop"}
```

### How the app uses signals

- **Has signal + has human turns in JSONL** → idle (ready for input)
- **Has signal + no human turns** → fresh (never used)
- **No signal + alive** → processing
- **Not alive** → dead
