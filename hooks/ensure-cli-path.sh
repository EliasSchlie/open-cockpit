#!/bin/bash
# Ensure cockpit-cli is on PATH by symlinking into ~/.local/bin/.
# Runs on SessionStart — auto-updates the symlink when the plugin version changes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_SRC="$SCRIPT_DIR/../bin/cockpit-cli"
CLI_DST="$HOME/.local/bin/cockpit-cli"

[ -x "$CLI_SRC" ] || exit 0
mkdir -p "$HOME/.local/bin"
ln -sf "$CLI_SRC" "$CLI_DST"
