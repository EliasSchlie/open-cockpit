#!/bin/bash
# shellcheck disable=SC2034  # variables are used by sourcing scripts
# Shared constants and helpers for all hooks.
#
# Usage (source from hook scripts):
#   source "$(dirname "$0")/common.sh"
#
# This sources log-error.sh automatically — no need to source both.

source "$(dirname "${BASH_SOURCE[0]}")/log-error.sh"

# --- Directory constants (used by sourcing scripts) ---
OC_DIR="$HOME/.open-cockpit"
SESSION_PIDS_DIR="$OC_DIR/session-pids"
SIGNAL_DIR="$OC_DIR/idle-signals"
INTENTIONS_DIR="$OC_DIR/intentions"
MARKER_DIR="$INTENTIONS_DIR/.intro-sent"
SNAPSHOT_DIR="$INTENTIONS_DIR/.snapshots"

# --- Shared helpers ---

# Extract a JSON string value using sed (avoids python3 startup overhead).
# Usage: json_get "$json_string" "key_name"
json_get() {
    echo "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# Resolve session_id from the PID mapping written by session-pid-map.sh.
# Sets $session_id or exits 0 if not found.
# Usage: resolve_session_id
resolve_session_id() {
    [ -f "$SESSION_PIDS_DIR/$PPID" ] || exit 0
    session_id=$(cat "$SESSION_PIDS_DIR/$PPID")
    [ -n "$session_id" ] || exit 0
}
