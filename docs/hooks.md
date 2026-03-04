# Plugin Hooks

The Claude Code plugin (`hooks/`) provides three hooks:

## `SessionStart` → `session-pid-map.sh`

Writes the session ID to `~/.claude/session-pids/<PID>` so the app can discover active sessions and map them to their intention files.

Without this hook, the app has no way to know which Claude processes correspond to which sessions.

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
