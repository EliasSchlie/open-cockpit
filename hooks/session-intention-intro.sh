#!/bin/bash
# Introduces Claude to the session's intention file on the first user prompt.
#
# Triggered by: UserPromptSubmit (fires once per context window via marker file)
# Input: none used (resolves session_id via PID mapping)
# Output (stdout): Instructions injected into Claude's context (first prompt only)

set -euo pipefail

hook_error() {
  echo "session-intention-intro error: $1" >&2
  exit 2
}
trap 'hook_error "unexpected failure at line $LINENO"' ERR

# Resolve session_id via PID mapping (written by session-pid-map.sh at SessionStart)
SESSION_PIDS_DIR="$HOME/.open-cockpit/session-pids"
[ -f "$SESSION_PIDS_DIR/$PPID" ] || exit 0
session_id=$(cat "$SESSION_PIDS_DIR/$PPID")
[ -n "$session_id" ] || exit 0

# Check if we already fired for this session ID (survives /clear → new session_id)
MARKER_DIR="$HOME/.open-cockpit/intentions/.intro-sent"
mkdir -p "$MARKER_DIR"

MARKER_FILE="$MARKER_DIR/$session_id"
if [ -f "$MARKER_FILE" ]; then
  exit 0
fi

# Mark as sent (do this early to avoid double-firing on race)
touch "$MARKER_FILE"

# Signal to intention-change-notify.sh to skip this prompt (avoid redundant output)
echo "$session_id" > "$MARKER_DIR/.just-fired"

# Clean up markers for sessions that no longer have a live PID
for f in "$MARKER_DIR"/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  # Skip dotfiles (like .just-fired)
  [[ "$name" == .* ]] && continue
  # Skip current session
  [ "$name" = "$session_id" ] && continue
  # Check if any alive PID maps to this session
  alive=false
  for pf in "$SESSION_PIDS_DIR"/*; do
    [ -f "$pf" ] || continue
    pid=$(basename "$pf")
    kill -0 "$pid" 2>/dev/null || continue
    sid=$(cat "$pf" 2>/dev/null) || continue
    if [ "$sid" = "$name" ]; then
      alive=true
      break
    fi
  done
  $alive || rm -f "$f"
done

INTENTION_FILE="$HOME/.open-cockpit/intentions/${session_id}.md"
SNAPSHOT_DIR="$HOME/.open-cockpit/intentions/.snapshots"
mkdir -p "$SNAPSHOT_DIR"

# Create initial snapshot for change detection (used by intention-change-notify.sh)
if [ -f "$INTENTION_FILE" ]; then
  cp "$INTENTION_FILE" "$SNAPSHOT_DIR/${session_id}.md"
fi

EMPTY_NOTE=""
if [ ! -f "$INTENTION_FILE" ] || [ ! -s "$INTENTION_FILE" ]; then
  EMPTY_NOTE=" (currently empty)"
fi

cat <<EOF
Describe this session at: ${INTENTION_FILE}${EMPTY_NOTE}

Write a descriptive heading, then short bullet points about what you're working on together. Add more detail below as needed.
EOF
