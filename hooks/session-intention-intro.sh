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

cat <<EOF
## Session Intention File

Your intention file lives at: $INTENTION_FILE

This file tracks what this session is about. At the start of a fresh session:
1. Read the intention file if it already has content — resume from there.
2. If it's empty or missing, collaborate with the user to define the session's goal:
   - Write a markdown title (# heading) that summarizes the intent.
   - Add a short description of what you'll accomplish together.
3. Update the intention file as the goal evolves during the session.

The user can also edit this file directly in the Open Cockpit app — you'll be notified of their changes.
EOF
