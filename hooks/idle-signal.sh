#!/bin/bash
# Signals when a Claude session becomes idle or starts processing.
# Called by Claude Code hooks (Stop, PreToolUse, PermissionRequest,
# PostToolUse, UserPromptSubmit, SessionStart).
#
# Usage: idle-signal.sh write [stop|tool|permission]
#        idle-signal.sh clear

set -euo pipefail

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

# Extract a JSON string value using sed (avoids python3 startup overhead)
json_get() {
    echo "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

case "${1:-}" in
    write)
        trigger="${2:-unknown}"
        input=$(read_input)
        session_id=""
        transcript=""
        if [ -n "$input" ]; then
            session_id=$(json_get "$input" "session_id")
            transcript=$(json_get "$input" "transcript_path")
        fi

        # Escape JSON string values (handle \, ", and control chars)
        json_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'; }

        # Write signal file as JSON
        printf '{"cwd":"%s","session_id":"%s","transcript":"%s","ts":%d,"trigger":"%s"}\n' \
            "$(json_esc "$(pwd)")" "$(json_esc "$session_id")" "$(json_esc "$transcript")" "$(date +%s)" "$(json_esc "$trigger")" > "$signal_file"

        # Block detection (Stop only): wait, then verify the session didn't continue.
        # Another Stop hook may have blocked → Claude gets re-prompted → not idle.
        if [ "$trigger" = "stop" ] && [ -n "$transcript" ] && [ -f "$transcript" ]; then
            saved_mtime=$(stat -f '%m' "$transcript" 2>/dev/null || echo 0)
            sleep 1
            # If signal was already cleared by UserPromptSubmit/PostToolUse, stop
            [ -f "$signal_file" ] || exit 0
            current_mtime=$(stat -f '%m' "$transcript" 2>/dev/null || echo 0)
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
