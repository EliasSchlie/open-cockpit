#!/bin/bash
# Signals when a Claude session becomes idle or starts processing.
# Called by Claude Code hooks (Stop, PreToolUse, PermissionRequest,
# PostToolUse, UserPromptSubmit, SessionStart).
#
# Usage: idle-signal.sh write [stop|tool|permission]
#        idle-signal.sh clear

set -euo pipefail

# Skip sub-claude sessions
[ "${SUB_CLAUDE:-}" = "1" ] && exit 0

SIGNAL_DIR="$HOME/.open-cockpit/idle-signals"
mkdir -p "$SIGNAL_DIR"

# $PPID is the Claude process that spawned this hook
claude_pid="$PPID"
signal_file="$SIGNAL_DIR/$claude_pid"

# Read hook input from stdin (JSON with session_id, transcript_path, etc.)
# Note: async hooks receive JSON without a trailing newline, causing `read`
# to return exit code 1 despite capturing the data. Use `|| true` to handle this.
read_input() {
    local line=""
    read -t 1 -r line 2>/dev/null || true
    if [ -n "$line" ]; then
        echo "$line"
        cat 2>/dev/null
    fi
}

case "${1:-}" in
    write)
        trigger="${2:-unknown}"
        input=$(read_input)
        session_id=""
        transcript=""
        if [ -n "$input" ]; then
            # Parse both fields in a single python3 call
            parsed=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id','')+'|'+d.get('transcript_path',''))" 2>/dev/null) || true
            session_id="${parsed%%|*}"
            transcript="${parsed#*|}"
        fi

        # Use env vars to avoid shell injection in python3 string interpolation
        IDLE_CWD="$(pwd)" IDLE_SID="$session_id" IDLE_TR="$transcript" IDLE_TRIG="$trigger" \
        python3 -c "
import json, time, os
d = {'cwd': os.environ['IDLE_CWD'], 'session_id': os.environ['IDLE_SID'],
     'transcript': os.environ['IDLE_TR'], 'ts': int(time.time()),
     'trigger': os.environ['IDLE_TRIG']}
print(json.dumps(d))
" > "$signal_file"

        # Block detection (Stop only): wait, then verify the session didn't continue.
        # Another Stop hook may have blocked → Claude gets re-prompted → not idle.
        if [ "$trigger" = "stop" ] && [ -n "$transcript" ] && [ -f "$transcript" ]; then
            saved_mtime=$(F="$transcript" python3 -c "import os; print(int(os.path.getmtime(os.environ['F'])))" 2>/dev/null || echo 0)
            sleep 1
            # If signal was already cleared by UserPromptSubmit/PostToolUse, stop
            [ -f "$signal_file" ] || exit 0
            current_mtime=$(F="$transcript" python3 -c "import os; print(int(os.path.getmtime(os.environ['F'])))" 2>/dev/null || echo 0)
            if [ "$current_mtime" -gt "$saved_mtime" ]; then
                # JSONL was modified after signal → session continued → not idle
                rm -f "$signal_file"
            fi
        fi
        ;;
    clear)
        rm -f "$signal_file"
        ;;
esac
