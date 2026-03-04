# Plugin Hooks

The Claude Code plugin (`hooks/`) provides one hook:

## `SessionStart` → `session-pid-map.sh`

Writes the session ID to `~/.claude/session-pids/<PID>` so the app can discover active sessions and map them to their intention files.

Without this hook, the app has no way to know which Claude processes correspond to which sessions.

Stale PID entries (dead processes) are cleaned up on each session start.
