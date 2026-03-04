# Required Claude Code Hooks

The app reads session data written by two Claude Code hooks. Both trigger on `SessionStart`.

## 1. `session-pid-map.sh`

Writes the session ID to `~/.claude/session-pids/<PID>`.

The app reads this directory to discover sessions and map PIDs to session IDs.

```bash
#!/bin/bash
set -euo pipefail
SESSION_DIR="$HOME/.claude/session-pids"
mkdir -p "$SESSION_DIR"
session_id=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null) || true
[ -z "$session_id" ] && exit 0
echo "$session_id" > "$SESSION_DIR/$PPID"
# Clean stale entries
for f in "$SESSION_DIR"/*; do
    [ -f "$f" ] || continue
    pid=$(basename "$f")
    kill -0 "$pid" 2>/dev/null || rm -f "$f"
done
```

## 2. `session-intention.sh`

Creates an empty intention file at `~/.intentions/<session_id>.md`.

```bash
#!/bin/bash
set -euo pipefail
INTENTIONS_DIR="$HOME/.intentions"
mkdir -p "$INTENTIONS_DIR"
session_id=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null) || true
[ -z "$session_id" ] && exit 0
[ -f "$INTENTIONS_DIR/$session_id.md" ] || touch "$INTENTIONS_DIR/$session_id.md"
```

## Hook registration

In Claude Code `settings.json` under `hooks.SessionStart`:

```json
{
  "hooks": [
    { "type": "command", "command": "bash ~/.claude/hooks/session-pid-map.sh" },
    { "type": "command", "command": "bash ~/.claude/hooks/session-intention.sh" }
  ]
}
```
