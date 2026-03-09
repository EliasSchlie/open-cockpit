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

- **Stop** hook: writes idle signal after a 5s deferred verify (`.pending` file PID mechanism prevents false positives on re-prompts)
- **UserPromptSubmit** hook: clears idle signal unconditionally (session is now processing)
- **PostToolUse** hook: clears idle signal but preserves `pool-init`/`session-clear` triggers (these mark genuinely idle sessions that shouldn't lose their signal during Claude's initial tool-use turn)

See [idle-signals.md](idle-signals.md) for full lifecycle details, all actors, and failure modes.
