# Custom Agents

Named, reusable shell scripts that compose `cockpit-cli` commands into higher-level workflows.

## Agent locations

| Location | Scope | Priority |
|----------|-------|----------|
| `.open-cockpit/agents/<name>.sh` | Project-local | Higher (overrides global) |
| `~/.open-cockpit/agents/<name>.sh` | Global | Lower |

## Creating an agent

1. Create the script file:

```bash
mkdir -p ~/.open-cockpit/agents
cat > ~/.open-cockpit/agents/code-review.sh << 'EOF'
#!/usr/bin/env bash
# Description: Review staged changes and suggest improvements
diff=$(git diff --cached)
if [[ -z "$diff" ]]; then
  echo "No staged changes to review." >&2
  exit 1
fi
id=$(cockpit-cli start "Review this diff and suggest improvements:\n$diff")
echo "$id"
EOF
chmod +x ~/.open-cockpit/agents/code-review.sh
```

2. The first `# Description:` comment is shown in `cockpit-cli agents` output and in the UI picker.

3. Make it executable (`chmod +x`).

## CLI usage

```bash
# List available agents
cockpit-cli agents

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

### Interactive (returns session ID)

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

Agents appear in the command palette via **Run Agent** (Cmd+Shift+A). The picker shows all discovered agents with their descriptions.

## API

The `list-agents` API endpoint returns discovered agents:

```json
{"type": "list-agents", "cwd": "/path/to/project"}
→ {"type": "agents", "agents": [{"name": "code-review", "path": "...", "description": "...", "scope": "global"}]}
```
