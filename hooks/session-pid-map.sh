#!/bin/bash
# Maps Claude process PID → session ID so external tools can identify sessions.
#
# Triggered by: SessionStart
# Input (stdin): JSON with session_id
# Output: ~/.claude/session-pids/<PID> containing the session ID

set -euo pipefail

SESSION_DIR="$HOME/.claude/session-pids"
mkdir -p "$SESSION_DIR"

# Read session_id from JSON stdin (async hooks may omit trailing newline)
session_id=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null) || true

[ -z "$session_id" ] && exit 0

# $PPID is the Claude process that spawned this hook
echo "$session_id" > "$SESSION_DIR/$PPID"

# Clean up stale entries and deduplicate same-UUID mappings
for f in "$SESSION_DIR"/*; do
    [ -f "$f" ] || continue
    pid=$(basename "$f")
    # Remove dead PIDs
    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$f"
        continue
    fi
    # Remove older alive duplicates mapping to the same session UUID
    [ "$pid" = "$PPID" ] && continue
    other_sid=$(cat "$f" 2>/dev/null) || continue
    if [ "$other_sid" = "$session_id" ]; then
        # Keep the newer file (ours); remove the older one
        if [ "$f" -ot "$SESSION_DIR/$PPID" ]; then
            rm -f "$f"
        fi
    fi
done

exit 0
