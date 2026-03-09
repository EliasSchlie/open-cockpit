#!/bin/bash
# Signals when a Claude session becomes idle or starts processing.
# Called by Claude Code hooks (Stop, PreToolUse, PermissionRequest,
# PostToolUse, UserPromptSubmit, SessionStart).
#
# IMPORTANT: Idle signals must have NO FALSE POSITIVES. A session must only
# be marked idle when it is truly waiting for user input. The "stop" trigger
# defers writing and verifies via a .pending file that the session wasn't
# re-prompted. Re-prompts are caught because:
#   - UserPromptSubmit clears the .pending file (via idle-signal.sh clear)
#   - A new Stop hook overwrites .pending with its own PID
#
# Usage: idle-signal.sh write [stop|tool|permission]
#        idle-signal.sh clear [post-tool]

set -euo pipefail
source "$(dirname "$0")/common.sh"

IDLE_VERIFY_DELAY=5
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

                # Wait before writing the signal. Re-prompts are detected
                # via .pending invalidation (UserPromptSubmit clears it,
                # new Stop hooks overwrite with their PID). No transcript
                # size check needed — it was racy with system entries
                # (stop_hook_summary, turn_duration) that Claude writes
                # concurrently, causing missed idle signals (#229).
                sleep "$IDLE_VERIFY_DELAY"

                # Abort if our pending claim was invalidated (clear or new stop)
                [ ! -f "$pending" ] && exit 0
                [ "$(cat "$pending" 2>/dev/null)" != "$$" ] && exit 0

                # Session is truly idle — write signal
                printf '%s\n' "$signal_json" > "$signal_file"
            ) &
            disown
        else
            # tool/permission triggers write immediately (user is already waiting)
            # Clear any pending deferred stop write so it doesn't overwrite this signal
            rm -f "$signal_file.pending"
            printf '%s\n' "$signal_json" > "$signal_file"
        fi
        ;;
    clear)
        caller="${2:-}"
        # PostToolUse fires during Claude's initial turn (before the user has
        # interacted), which deletes the pool-init idle signal AND aborts any
        # pending deferred Stop write — leaving no signal until reconcilePool
        # recreates it ~30s later.
        #
        # Fix: when called from PostToolUse, preserve pool-init/session-clear
        # signals — they mark genuinely idle sessions that haven't had user
        # interaction yet. The Stop hook's deferred write will overwrite them
        # with a real "stop" trigger once Claude's turn finishes.
        if [ "$caller" = "post-tool" ] && [ -f "$signal_file" ]; then
            trigger=$(json_get "$(cat "$signal_file")" "trigger") || true
            if [ "$trigger" = "pool-init" ] || [ "$trigger" = "session-clear" ]; then
                rm -f "$signal_file.pending"
                exit 0
            fi
        fi
        rm -f "$signal_file" "$signal_file.pending"
        ;;
esac
