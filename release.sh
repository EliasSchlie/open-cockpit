#!/usr/bin/env bash
# DEPRECATED: CI now handles patch releases automatically on push to main.
# Use this only as a manual fallback or for explicit major/minor bumps.
#
# Usage: ./release.sh          # auto-increments patch (0.1.0 → 0.1.1)
#        ./release.sh 1.0.0    # explicit version

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKETPLACE_DIR="$HOME/Documents/Projects/claude-plugins"
PLUGIN_JSON="$REPO_DIR/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$MARKETPLACE_DIR/.claude-plugin/marketplace.json"

# --- resolve version ---

current=$(python3 -c "import json; print(json.load(open('$PLUGIN_JSON'))['version'])")

if [ -n "${1:-}" ]; then
    new="$1"
else
    IFS='.' read -r major minor patch <<< "$current"
    new="${major}.${minor}.$((patch + 1))"
fi

echo "Version: $current → $new"

# --- check prerequisites ---

if [ ! -d "$MARKETPLACE_DIR/.git" ]; then
    echo "Error: marketplace repo not found at $MARKETPLACE_DIR"
    echo "Clone it: git clone git@github.com:EliasSchlie/claude-plugins.git $MARKETPLACE_DIR"
    exit 1
fi

if ! git -C "$REPO_DIR" diff --quiet 2>/dev/null; then
    echo "Error: open-cockpit has uncommitted changes. Commit first."
    exit 1
fi
if ! git -C "$REPO_DIR" diff origin/main --quiet 2>/dev/null; then
    echo "Error: open-cockpit has unpushed commits. Push first."
    exit 1
fi
if ! git -C "$MARKETPLACE_DIR" diff --quiet 2>/dev/null; then
    echo "Error: claude-plugins has uncommitted changes. Commit first."
    exit 1
fi

# --- bump this repo ---

python3 -c "
import json
p = json.load(open('$PLUGIN_JSON'))
p['version'] = '$new'
json.dump(p, open('$PLUGIN_JSON', 'w'), indent=2)
print('  Updated $PLUGIN_JSON')
"

git -C "$REPO_DIR" add .claude-plugin/plugin.json
git -C "$REPO_DIR" commit -m "Release v$new"
git -C "$REPO_DIR" push
echo "  Pushed open-cockpit"

# --- bump marketplace (sync with remote first) ---

git -C "$MARKETPLACE_DIR" pull --rebase origin main

python3 -c "
import json
m = json.load(open('$MARKETPLACE_JSON'))
for p in m['plugins']:
    if p['name'] == 'open-cockpit':
        p['version'] = '$new'
        break
json.dump(m, open('$MARKETPLACE_JSON', 'w'), indent=2)
print('  Updated $MARKETPLACE_JSON')
"

git -C "$MARKETPLACE_DIR" add .claude-plugin/marketplace.json
git -C "$MARKETPLACE_DIR" commit -m "Bump open-cockpit to $new"
git -C "$MARKETPLACE_DIR" push
echo "  Pushed marketplace"

echo ""
echo "Released v$new. New sessions will auto-update."
