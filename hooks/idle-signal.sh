#!/bin/bash
# Signals when a Claude session becomes idle or starts processing.
# Called by Claude Code hooks (Stop, PreToolUse, PermissionRequest,
# PostToolUse, UserPromptSubmit, SessionStart).
#
# IMPORTANT: Idle signals must have NO FALSE POSITIVES. A session must only
# be marked idle when it is truly waiting for user input. The "stop" trigger
# defers writing for IDLE_VERIFY_DELAY seconds and verifies the transcript
# hasn't changed (which would indicate a re-prompt from another Stop hook).
#
# Usage: idle-signal.sh write [stop|tool|permission]
#        idle-signal.sh clear

set -euo pipefail

SIGNAL_DIR="$HOME/.open-cockpit/idle-signals"
IDLE_VERIFY_DELAY=3
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

# Cross-platform file mtime in epoch seconds (macOS uses -f, Linux uses -c)
file_mtime() {
    stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
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

        # Build the signal JSON (capture now, write later for deferred triggers)
        signal_json=$(printf '{"cwd":"%s","session_id":"%s","transcript":"%s","ts":%d,"trigger":"%s"}\n' \
            "$(json_esc "$(pwd)")" "$(json_esc "$session_id")" "$(json_esc "$transcript")" "$(date +%s)" "$(json_esc "$trigger")")

        if [ "$trigger" = "stop" ]; then
            # Defer: verify session is truly idle before writing.
            # Another Stop hook may re-prompt Claude, making it not actually idle.
            pending="$signal_file.pending"
            echo "$$" > "$pending"

            (
                trap 'rm -f "$pending"' EXIT

                before=""
                if [ -n "$transcript" ] && [ -f "$transcript" ]; then
                    before=$(file_mtime "$transcript")
                fi

                i=0
                while [ "$i" -lt "$IDLE_VERIFY_DELAY" ]; do
                    sleep 1
                    i=$((i + 1))

                    # Abort if our pending claim was invalidated (clear or new stop)
                    [ ! -f "$pending" ] && exit 0
                    [ "$(cat "$pending" 2>/dev/null)" != "$$" ] && exit 0

                    # Abort if transcript changed (re-prompt or user input)
                    if [ -n "$before" ] && [ -f "$transcript" ]; then
                        after=$(file_mtime "$transcript")
                        [ "$before" != "$after" ] && exit 0
                    fi
                done

                # Session is truly idle — write signal
                printf '%s\n' "$signal_json" > "$signal_file"
            ) &
            disown
        else
            # tool/permission triggers write immediately (user is already waiting)
            printf '%s\n' "$signal_json" > "$signal_file"
        fi
        ;;
    clear)
        rm -f "$signal_file" "$signal_file.pending"
        ;;
esac
