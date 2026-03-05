#!/bin/bash
# Reminds Claude to keep the intention file updated, and surfaces user edits.
#
# Triggered by: UserPromptSubmit
# Input: none used (resolves session_id via PID mapping)
# Output (stdout): Always a reminder; includes diff if user edited the file

set -euo pipefail

hook_error() {
  echo "intention-change-notify error: $1" >&2
  exit 2
}
trap 'hook_error "unexpected failure at line $LINENO"' ERR

# Resolve session_id via PID mapping (written by session-pid-map.sh)
SESSION_PIDS_DIR="$HOME/.open-cockpit/session-pids"
[ -f "$SESSION_PIDS_DIR/$PPID" ] || exit 0
session_id=$(cat "$SESSION_PIDS_DIR/$PPID")
[ -n "$session_id" ] || exit 0

INTENTION_FILE="$HOME/.open-cockpit/intentions/${session_id}.md"
SNAPSHOT_DIR="$HOME/.open-cockpit/intentions/.snapshots"
SNAPSHOT_FILE="$SNAPSHOT_DIR/${session_id}.md"

mkdir -p "$SNAPSHOT_DIR"

# Detect user edits (diff against snapshot)
DIFF=""
if [ -f "$INTENTION_FILE" ] && [ -f "$SNAPSHOT_FILE" ]; then
  DIFF=$(diff -u "$SNAPSHOT_FILE" "$INTENTION_FILE" --label "previous" --label "current" 2>/dev/null) || true
  if [ -n "$DIFF" ]; then
    cp "$INTENTION_FILE" "$SNAPSHOT_FILE"
  fi
elif [ -f "$INTENTION_FILE" ] && [ ! -f "$SNAPSHOT_FILE" ]; then
  cp "$INTENTION_FILE" "$SNAPSHOT_FILE"
fi

# Always remind; append user diff if present
echo "Reminder: keep the intention file up to date."
if [ -n "$DIFF" ]; then
  cat <<EOF

User changes:
\`\`\`diff
$DIFF
\`\`\`
EOF
fi
