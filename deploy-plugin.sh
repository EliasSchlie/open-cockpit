#!/bin/bash
# Deploy open-cockpit plugin to local Claude Code cache.
# Bumps patch version, copies plugin files, updates installed_plugins.json.
# Run after editing skills/hooks. Then /reload-plugins in active sessions.
set -euo pipefail

SCRIPT_DIR=$(dirname "$(realpath "$0")")
PLUGIN_JSON="$SCRIPT_DIR/.claude-plugin/plugin.json"
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
PLUGIN_KEY="open-cockpit@local-tools"

# --- Bump patch version in source plugin.json ---
old_version=$(python3 -c "import json; print(json.load(open('$PLUGIN_JSON'))['version'])")
IFS='.' read -r major minor patch <<< "$old_version"
new_version="$major.$minor.$((patch + 1))"
python3 -c "
import json
p = json.load(open('$PLUGIN_JSON'))
p['version'] = '$new_version'
json.dump(p, open('$PLUGIN_JSON', 'w'), indent=2)
print()
"
echo "  Version: $old_version → $new_version"

# --- Copy plugin files to cache ---
CACHE_BASE="$HOME/.claude/plugins/cache/local-tools/open-cockpit"
CACHE_DIR="$CACHE_BASE/$new_version"

# Remove all old cached versions
if [ -d "$CACHE_BASE" ]; then
  for old in "$CACHE_BASE"/*/; do
    [ -d "$old" ] && rm -rf "$old"
  done
fi
mkdir -p "$CACHE_DIR"

# Only copy plugin-relevant files
for item in .claude-plugin skills hooks bin; do
  [ -e "$SCRIPT_DIR/$item" ] && cp -R "$SCRIPT_DIR/$item" "$CACHE_DIR/"
done

echo "  Cache: $CACHE_DIR"

# --- Update installed_plugins.json ---
if [ -f "$INSTALLED" ]; then
  python3 -c "
import json
from datetime import datetime, timezone

path = '$INSTALLED'
data = json.load(open(path))
key = '$PLUGIN_KEY'
cache = '$CACHE_DIR'
version = '$new_version'
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

plugins = data.setdefault('plugins', {})
if key in plugins:
    for entry in plugins[key]:
        entry['version'] = version
        entry['installPath'] = cache
        entry['lastUpdated'] = now
    json.dump(data, open(path, 'w'), indent=2)
    print()
    print(f'  Updated {key} in installed_plugins.json')
else:
    # First time: create the entry
    plugins[key] = [{'scope': 'user', 'installPath': cache, 'version': version, 'installedAt': now, 'lastUpdated': now}]
    json.dump(data, open(path, 'w'), indent=2)
    print()
    print(f'  Created {key} in installed_plugins.json')
" || true
fi

# --- Commit version bump ---
cd "$SCRIPT_DIR"
git add .claude-plugin/plugin.json
git commit -m "Bump plugin to v$new_version [skip ci]" --quiet 2>/dev/null || true

echo "  ✅ Deployed. Run /reload-plugins in active sessions."
