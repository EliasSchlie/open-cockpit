#!/bin/bash
# Maps Claude process PID → session ID so external tools can identify sessions.
#
# Triggered by: SessionStart
# Input (stdin): JSON with session_id
# Output: ~/.open-cockpit/session-pids/<PID> containing the session ID

set -euo pipefail
source "$(dirname "$0")/common.sh"

mkdir -p "$SESSION_PIDS_DIR"

# Read session_id from JSON stdin (avoid python3 startup overhead)
input=""
read -t 1 -r input 2>/dev/null || true
session_id=$(json_get "$input" "session_id") || true

[ -z "$session_id" ] && exit 0

# $PPID is the Claude process that spawned this hook
echo "$session_id" > "$SESSION_PIDS_DIR/$PPID"

# Clean up stale entries (PIDs that no longer exist)
for f in "$SESSION_PIDS_DIR"/*; do
    [ -f "$f" ] || continue
    pid=$(basename "$f")
    kill -0 "$pid" 2>/dev/null || rm -f "$f"
done

# Deduplicate: if another alive PID maps to same session_id, remove the older file
for f in "$SESSION_PIDS_DIR"/*; do
    [ -f "$f" ] || continue
    pid=$(basename "$f")
    [ "$pid" = "$PPID" ] && continue
    kill -0 "$pid" 2>/dev/null || continue
    other_sid=$(cat "$f" 2>/dev/null) || continue
    if [ "$other_sid" = "$session_id" ]; then
        if [ "$f" -ot "$SESSION_PIDS_DIR/$PPID" ]; then
            rm -f "$f"
        fi
    fi
done

exit 0
