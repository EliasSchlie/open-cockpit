# Custom Agents

Named, reusable shell scripts that compose `cockpit-cli` commands into higher-level workflows.

## Agent locations

| Location | Scope | Priority |
|----------|-------|----------|
| `.open-cockpit/agents/<name>.sh` | Project-local | Higher (overrides global) |
| `~/.open-cockpit/agents/<name>.sh` | Global | Lower |

## Quick start

```bash
mkdir -p ~/.open-cockpit/agents
cat > ~/.open-cockpit/agents/review.sh << 'EOF'
#!/usr/bin/env bash
# Description: Review staged changes and suggest improvements
# Arg: focus | Area to focus on | optional | default: general

diff=$(git diff --cached)
if [[ -z "$diff" ]]; then
  echo "No staged changes to review." >&2
  exit 1
fi
cockpit-cli start "Review this diff (focus: ${1:-general}):\n$diff"
EOF
chmod +x ~/.open-cockpit/agents/review.sh
```

## Metadata comments

Agent scripts support header comments for self-documentation:

```bash
#!/usr/bin/env bash
# Description: One-line summary shown in listings and UI
# Arg: target | Files to review
# Arg: --format | Output format | optional | default: markdown
```

### `# Description:`

First occurrence is shown in `cockpit-cli agents`, `--help`, and the UI picker.

### `# Arg:` format

```
# Arg: name | description | optional | default: value
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | Argument name (e.g. `target`, `--format`) |
| `description` | No | Shown in `--help` and UI fields |
| `optional` | No | Omit for required args |
| `default: value` | No | Default value hint |

Arguments are passed positionally (`$1`, `$2`, ...) regardless of metadata.

## CLI usage

```bash
# List available agents
cockpit-cli agents

# List with argument details
cockpit-cli agents -v

# Show agent help
cockpit-cli agent <name> --help

# Run an agent
cockpit-cli agent <name> [args...]
```

## Patterns

### One-shot (blocking)

```bash
#!/usr/bin/env bash
# Description: Quick summarize
id=$(cockpit-cli start "$*" --block --quiet)
cockpit-cli result "$id" -v response
```

### Interactive (non-blocking)

`cockpit-cli start` prints the session ID to both stdout and stderr. In non-blocking mode, the caller gets the ID on stdout for scripting:

```bash
#!/usr/bin/env bash
# Description: Start a research session
cockpit-cli start "Research: $*"
```

### Multi-turn within script

```bash
#!/usr/bin/env bash
# Description: Deep analysis with follow-up
id=$(cockpit-cli start "Analyze: $1")
cockpit-cli wait "$id"
cockpit-cli followup "$id" "Now suggest fixes" --block
cockpit-cli result "$id" -v response
```

### Parallel fan-out

```bash
#!/usr/bin/env bash
# Description: Security + performance review
id1=$(cockpit-cli start "Security review of $1")
id2=$(cockpit-cli start "Performance review of $1")
cockpit-cli wait "$id1"
cockpit-cli wait "$id2"
echo "=== Security ==="
cockpit-cli result "$id1" -v response
echo "=== Performance ==="
cockpit-cli result "$id2" -v response
```

## UI integration

Agents appear in the command palette via **Run Agent** (⌘⇧A). The picker shows all discovered agents with descriptions and typed input fields for each `# Arg:` definition.

### Stderr side-channel

When the UI invokes an agent, it captures the session ID from the script's **stderr** (not stdout). This works because `cockpit-cli start` always writes the session ID to stderr. The UI navigates to the session immediately while the script continues in background.

This means agent scripts don't need special UI handling — `cockpit-cli start` handles it automatically.

## API

The `list-agents` API endpoint returns discovered agents with metadata:

```json
{"type": "list-agents", "cwd": "/path/to/project"}
→ {"type": "agents", "agents": [
    {"name": "review", "path": "...", "description": "Review staged changes", "scope": "global",
     "args": [{"name": "focus", "description": "Area to focus on", "required": false, "default": "general"}]}
  ]}
```
