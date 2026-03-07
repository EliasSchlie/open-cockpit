#!/bin/bash
# Signals when a Claude session becomes idle or starts processing.
# Called by Claude Code hooks (Stop, PreToolUse, PermissionRequest,
# PostToolUse, UserPromptSubmit, SessionStart).
#
# IMPORTANT: Idle signals must have NO FALSE POSITIVES. A session must only
# be marked idle when it is truly waiting for user input. The "stop" trigger
# defers writing for IDLE_VERIFY_DELAY seconds and verifies the transcript
# size hasn't changed (which would indicate a re-prompt from another Stop hook).
# Uses file SIZE (not mtime) because Claude keeps the JSONL file handle open,
# causing mtime updates even without new content, and writes system entries
# (stop_hook_summary, turn_duration) after the Stop hook fires.
#
# Usage: idle-signal.sh write [stop|tool|permission]
#        idle-signal.sh clear

set -euo pipefail
source "$(dirname "$0")/common.sh"

SYSTEM_ENTRY_WAIT=4
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

# Cross-platform file size in bytes (macOS uses -f, Linux uses -c)
file_size() {
    stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null || echo 0
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
        json_esc() {
            printf '%s' "$1" | awk '
                BEGIN { ORS="" }
                {
                    if (NR > 1) printf "\\n"
                    gsub(/\\/, "\\\\")
                    gsub(/"/, "\\\"")
                    gsub(/\t/, "\\t")
                    gsub(/\r/, "\\r")
                    gsub(/\x08/, "\\b")
                    gsub(/\x0c/, "\\f")
                    printf "%s", $0
                }
            '
        }

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

                # Wait for system entries (stop_hook_summary, turn_duration)
                # to finish writing. With async:true, Claude writes these
                # concurrently (not blocked by the hook), so they can take
                # up to ~3s to appear. Use SYSTEM_ENTRY_WAIT for margin.
                sleep "$SYSTEM_ENTRY_WAIT"

                # Abort early if pending was invalidated during system-entry wait
                [ ! -f "$pending" ] && exit 0
                [ "$(cat "$pending" 2>/dev/null)" != "$$" ] && exit 0

                # Record file size AFTER system entries are done.
                # A re-prompt would add new content (tool calls, assistant text).
                before=""
                if [ -n "$transcript" ] && [ -f "$transcript" ]; then
                    before=$(file_size "$transcript")
                fi

                sleep "$IDLE_VERIFY_DELAY"

                # Abort if our pending claim was invalidated (clear or new stop)
                [ ! -f "$pending" ] && exit 0
                [ "$(cat "$pending" 2>/dev/null)" != "$$" ] && exit 0

                # Abort if transcript grew (re-prompt or user input added content)
                if [ -n "$before" ] && [ -f "$transcript" ]; then
                    after=$(file_size "$transcript")
                    [ "$before" != "$after" ] && exit 0
                fi

                # Session is truly idle — write signal (re-check pending to close TOCTOU race)
                if [ "$(cat "$pending" 2>/dev/null)" = "$$" ]; then
                    printf '%s\n' "$signal_json" > "$signal_file"
                fi
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
