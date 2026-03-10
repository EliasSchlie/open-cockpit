---
name: agents
description: Use when you need to run a named agent (reusable task script) or list available agents.
---

# Custom Agents

Named, reusable shell scripts that compose `cockpit-cli` commands. Agents live in:

- **Global**: `~/.open-cockpit/agents/<name>.sh`
- **Project-local**: `.open-cockpit/agents/<name>.sh` (overrides global)

## List available agents

```bash
cockpit-cli agents
```

## Run an agent

```bash
cockpit-cli agent <name> [args...]
```

The agent script owns the full lifecycle — it may be one-shot (blocking, prints result) or interactive (prints a session ID for follow-up).

## Follow up on an agent's session

If an agent prints a session ID, use existing commands:

```bash
id=$(cockpit-cli agent analyze-code src/)
cockpit-cli wait "$id"
cockpit-cli followup "$id" "now focus on error handling"
cockpit-cli wait "$id"
cockpit-cli result "$id" -v response
```

## Writing agent scripts

Agent scripts are executable `.sh` files. First `# Description:` comment is shown in listings.

```bash
#!/usr/bin/env bash
# Description: Review staged changes
diff=$(git diff --cached)
id=$(cockpit-cli start "Review this diff:\n$diff" --block --quiet)
cockpit-cli result "$id" -v response
```

Make executable: `chmod +x ~/.open-cockpit/agents/code-review.sh`
