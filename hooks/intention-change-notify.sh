#!/bin/bash
# Detects user edits to the intention file and surfaces the diff to Claude.
#
# Triggered by: UserPromptSubmit
# Input: none used (resolves session_id via PID mapping)
# Output (stdout): Change notification with diff, or nothing if unchanged

set -euo pipefail

hook_error() {
  echo "intention-change-notify error: $1" >&2
  exit 2
}
trap 'hook_error "unexpected failure at line $LINENO"' ERR

# Resolve session_id via PID mapping (written by session-pid-map.sh)
SESSION_PIDS_DIR="$HOME/.claude/session-pids"
[ -f "$SESSION_PIDS_DIR/$PPID" ] || exit 0
session_id=$(cat "$SESSION_PIDS_DIR/$PPID")
[ -n "$session_id" ] || exit 0

INTENTION_FILE="$HOME/.open-cockpit/intentions/${session_id}.md"
SNAPSHOT_DIR="$HOME/.open-cockpit/intentions/.snapshots"
SNAPSHOT_FILE="$SNAPSHOT_DIR/${session_id}.md"

mkdir -p "$SNAPSHOT_DIR"

# No intention file yet — nothing to compare
[ -f "$INTENTION_FILE" ] || exit 0

# No snapshot yet — create baseline, no notification
if [ ! -f "$SNAPSHOT_FILE" ]; then
  cp "$INTENTION_FILE" "$SNAPSHOT_FILE"
  exit 0
fi

# Compare current file to snapshot (single diff call, check exit code)
DIFF=$(diff -u "$SNAPSHOT_FILE" "$INTENTION_FILE" --label "previous" --label "current" 2>/dev/null) || true
if [ -n "$DIFF" ]; then
  cp "$INTENTION_FILE" "$SNAPSHOT_FILE"
  cat <<EOF
The user updated their intention file ($INTENTION_FILE):

\`\`\`diff
$DIFF
\`\`\`

Review the changes and adjust your approach accordingly.
EOF
fi
