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

# --- Best-effort CLI symlinks (non-critical) ---
# Failures here must not prevent session registration above.
{
    OC_BIN_DIR="$OC_DIR/bin"
    PLUGIN_CLI="$(dirname "$0")/../bin/cockpit-cli"
    if [ -f "$PLUGIN_CLI" ]; then
        target="$(cd "$(dirname "$PLUGIN_CLI")" && pwd)/cockpit-cli"
        if [ "$(readlink "$OC_BIN_DIR/cockpit-cli" 2>/dev/null)" != "$target" ]; then
            mkdir -p "$OC_BIN_DIR"
            ln -sf "$target" "$OC_BIN_DIR/cockpit-cli"
        fi
        # Also symlink into /usr/local/bin so it's on PATH without shell config changes
        if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
            if [ "$(readlink /usr/local/bin/cockpit-cli 2>/dev/null)" != "$OC_BIN_DIR/cockpit-cli" ]; then
                ln -sf "$OC_BIN_DIR/cockpit-cli" /usr/local/bin/cockpit-cli 2>/dev/null || true
            fi
        fi
    fi
} 2>/dev/null || true

# Clean up stale entries (PIDs that no longer exist)
for f in "$SESSION_PIDS_DIR"/*; do
    [ -f "$f" ] || continue
    pid=$(basename "$f")
    if ! kill -0 "$pid" 2>/dev/null; then
        printf '%s [hook:session-pid-map] Cleanup: removing session-pids/%s (process dead)\n' "$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" "$pid" >> "$OC_DIR/debug.log" 2>/dev/null || true
        rm -f "$f"
    fi
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
            printf '%s [hook:session-pid-map] Dedup: removing session-pids/%s (same session_id=%s as PID %s, older file)\n' "$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')" "$pid" "$session_id" "$PPID" >> "$OC_DIR/debug.log" 2>/dev/null || true
            rm -f "$f"
        fi
    fi
done

exit 0
