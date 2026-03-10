#!/bin/bash
# Logs hook errors to $OPEN_COCKPIT_DIR/logs/hooks.log with rotation.
#
# Usage (source from hook scripts):
#   source "$(dirname "$0")/log-error.sh"
#
# This replaces the default ERR trap with one that logs to a file,
# making hook failures discoverable instead of silently lost to stderr.
#
# Note: This sets a trap on ERR. If a hook needs its own ERR trap,
# it must call _hook_log_error manually from within it.

HOOK_LOG_DIR="${OPEN_COCKPIT_DIR:-$HOME/.open-cockpit}/logs"
HOOK_LOG_FILE="$HOOK_LOG_DIR/hooks.log"
HOOK_LOG_MAX_SIZE=102400  # 100KB

_hook_log_error() {
  local script_name="${HOOK_SCRIPT_NAME:-$(basename "${BASH_SOURCE[1]:-$0}")}"
  local line="${1:-unknown}"
  local msg="${2:-unexpected failure}"

  mkdir -p "$HOOK_LOG_DIR" 2>/dev/null || true

  # Rotate if too large (wc -c is POSIX-portable, unlike stat flags)
  local size=0
  [ -f "$HOOK_LOG_FILE" ] && size=$(wc -c < "$HOOK_LOG_FILE" 2>/dev/null) || true
  if [ "${size:-0}" -gt "$HOOK_LOG_MAX_SIZE" ]; then
    mv "$HOOK_LOG_FILE" "$HOOK_LOG_FILE.1" 2>/dev/null || true
  fi

  printf '[%s] %s:%s — %s (pid=%s ppid=%s)\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" \
    "$script_name" "$line" "$msg" \
    "$$" "$PPID" \
    >> "$HOOK_LOG_FILE" 2>/dev/null || true
}

# Set trap — hooks can override HOOK_SCRIPT_NAME before sourcing
trap '_hook_log_error "$LINENO" "ERR trap triggered"; exit 2' ERR
