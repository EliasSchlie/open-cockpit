---
name: cockpit-agents
description: Use when you need to run a reusable agent template — pre-defined prompt+config combos that launch as pool sessions.
---

# cockpit-agents

Run pre-defined agent templates as pool sessions. Templates are markdown files with YAML frontmatter defining description, cwd, flags, and a prompt body.

## Template locations

```
~/.open-cockpit/agents/<name>.md       # Global (available everywhere)
<project>/.open-cockpit/agents/<name>.md  # Project-local (overrides global)
```

## Template format

```markdown
---
description: One-line description
cwd: .
flags: --model sonnet
---
Your prompt here.

{{args}}
```

- `description` — shown in listings
- `cwd` — working directory (`.` = caller's cwd, `~` = home, or absolute)
- `flags` — extra CLI flags (e.g. `--model sonnet`). If set, spawns a custom session instead of using the pool
- `{{args}}` — replaced with runtime arguments (removed if none provided)

## CLI usage

```bash
# List available agents
cockpit-cli agent list
cockpit-cli agent list --project /path/to/project

# Run an agent (returns session ID)
id=$(cockpit-cli agent run reviewer)

# Run with arguments
id=$(cockpit-cli agent run reviewer "PR #42")

# Run and wait for result
result=$(cockpit-cli -v response agent run summarizer "src/" --block)

# Run with explicit cwd
cockpit-cli agent run deployer --cwd /path/to/project --block
```

## API usage

```json
{"type": "agent-list", "projectDir": "/optional/path"}
→ {"type": "agents", "agents": [{name, description, cwd, flags, prompt, filePath}, ...]}

{"type": "agent-run", "name": "reviewer", "args": "PR #42", "parentSessionId": "..."}
→ {"type": "agent-started", "agentName": "reviewer", "sessionId": "...", "termId": ..., "slotIndex": ..., "mode": "pool"}
```

## Combining with cockpit-sessions

Agent templates are a higher-level abstraction over `cockpit-cli start`. After launching, use the same session commands:

```bash
id=$(cockpit-cli agent run reviewer "PR #42")
cockpit-cli wait "$id"
cockpit-cli -v response result "$id"
cockpit-cli followup "$id" "also check for security issues"
```

## Creating templates

```bash
mkdir -p ~/.open-cockpit/agents
cat > ~/.open-cockpit/agents/reviewer.md << 'EOF'
---
description: Code review agent
---
Review the code changes in the current branch. Focus on:
- Security issues
- Performance concerns
- Code style violations

{{args}}
EOF
```
