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
cockpit-cli agents        # compact listing
cockpit-cli agents -v     # with argument details
```

## Run an agent

```bash
cockpit-cli agent <name> [args...]
cockpit-cli agent <name> --help   # show usage info
```

The agent script owns the full lifecycle — it may be one-shot (blocking, prints result) or interactive (non-blocking, prints a session ID).

## Follow up on an agent's session

`cockpit-cli start` prints the session ID to stdout (for capture) and stderr (for UI):

```bash
id=$(cockpit-cli agent analyze-code src/)
cockpit-cli wait "$id"
cockpit-cli followup "$id" "now focus on error handling"
cockpit-cli wait "$id"
cockpit-cli result "$id" -v response
```

## Writing agent scripts

Agent scripts are executable `.sh` files with optional metadata comments:

```bash
#!/usr/bin/env bash
# Description: Review staged changes
# Arg: focus | Area to focus on | optional | default: general

diff=$(git diff --cached)
cockpit-cli start "Review this diff (focus: ${1:-general}):\n$diff"
```

Make executable: `chmod +x ~/.open-cockpit/agents/review.sh`

### Arg metadata format

```
# Arg: name | description | optional | default: value
```

Arguments are passed positionally (`$1`, `$2`, ...). Metadata provides documentation and typed UI fields in the agent picker (⌘⇧A).
