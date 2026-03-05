#!/bin/bash
# Introduces Claude to the session's intention file at session start.
#
# Triggered by: SessionStart
# Input (stdin): JSON with session_id
# Output (stdout): Instructions injected into Claude's context

set -euo pipefail

hook_error() {
  echo "session-intention-intro error: $1" >&2
  exit 2
}
trap 'hook_error "unexpected failure at line $LINENO"' ERR

# Read session_id from JSON stdin (async hooks may omit trailing newline)
session_id=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null) || true
[ -z "$session_id" ] && exit 0

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
