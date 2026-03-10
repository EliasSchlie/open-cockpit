# Custom Sub-Agents for Open Cockpit

Builds on the [sub-claude merge design](2026-03-06-sub-claude-merge-design.md) — implements the "custom agents" feature deferred there.

## Goal

Named, reusable agent definitions that any Claude session (or human) can invoke with a single command. Agents run in pool slots and reuse existing `cockpit-cli` commands (`followup`, `result`, `wait`) for back-and-forth.

## How It Works

### Agent Definitions

Shell scripts discovered by filesystem scan (same pattern as sub-claude):

1. **Project-local**: `.open-cockpit/agents/<name>.sh` (project-specific)
2. **Global**: `~/.open-cockpit/agents/<name>.sh` (user-wide)

Project-local overrides global. First `# Description:` comment line shown in listings.

```bash
#!/usr/bin/env bash
# Description: Review staged changes and suggest improvements
diff=$(git diff --cached)
id=$(cockpit-cli start "Review this diff and suggest improvements:\n$diff" --block --quiet)
cockpit-cli result "$id" -v response
```

### CLI Commands

Only two new commands — everything else reuses existing CLI:

```bash
# List available agents
cockpit-cli agents

# Run an agent (starts session, prints session ID)
cockpit-cli agent <name> [args...]
```

After that, use **existing commands** with the returned session ID:

```bash
cockpit-cli wait <session-id>           # already exists
cockpit-cli followup <session-id> "msg" # already exists
cockpit-cli result <session-id> -v resp # already exists
cockpit-cli stop <session-id>           # already exists
cockpit-cli pin <session-id>            # already exists
```

### Why No Agent-Specific IDs

The session ID returned by `cockpit-cli agent <name>` **is** the identifier for all further interaction. No separate agent ID layer needed because:

- Session IDs already work with `followup`, `result`, `wait`, `stop`, `pin`
- Adding an alias layer (short hex → UUID mapping) means extra state to track and clean up
- Claude sessions already deal in session IDs — one less concept to learn

If session UUIDs are too long to type for humans, the existing prefix-match addressing in `cockpit-cli` handles that (e.g., `cockpit-cli followup a1b2` matches the session starting with `a1b2`).

### How `cockpit-cli agent` Works

1. Scans agent dirs for `<name>.sh`
2. Executes the script, passing remaining args: `exec "$script" "$@"`
3. Script composes `cockpit-cli` primitives internally
4. Script prints the session ID to stdout (convention)

The agent script owns the full lifecycle — it can be one-shot (blocking) or return an ID for later interaction.

### How Claude Sessions Use It

The skill file teaches Claude the commands:

```bash
# One-shot: run and get result
cockpit-cli agent code-review --staged

# Interactive: run, then follow up
id=$(cockpit-cli agent analyze-codebase --quiet)
cockpit-cli wait "$id"
result=$(cockpit-cli result "$id" -v response)
# ... process result ...
cockpit-cli followup "$id" "Now focus on the auth module"
cockpit-cli wait "$id"
```

Identical for humans and Claude sessions — no separate API.

### Keyboard Shortcuts (UI)

Agents show up in the command palette (Cmd+Shift+P). Each becomes a palette entry with its description. Selecting one prompts for arguments (or runs immediately if none needed).

Piggybacks on existing command palette — no new UI surface.

### Agent Script Patterns

**One-shot** (blocks, prints result):
```bash
#!/usr/bin/env bash
# Description: Quick code review
id=$(cockpit-cli start "$*" --block --quiet)
cockpit-cli result "$id" -v response
```

**Interactive** (returns ID for later):
```bash
#!/usr/bin/env bash
# Description: Start a research session
cockpit-cli start "Research: $*" --quiet
```

**Multi-turn within script**:
```bash
#!/usr/bin/env bash
# Description: Deep analysis with follow-up
id=$(cockpit-cli start "Analyze: $1" --quiet)
cockpit-cli wait "$id"
cockpit-cli followup "$id" "Now suggest fixes"
cockpit-cli wait "$id"
cockpit-cli result "$id" -v response
```

**Parallel fan-out**:
```bash
#!/usr/bin/env bash
# Description: Security + performance review
id1=$(cockpit-cli start "Security review: $1" --quiet)
id2=$(cockpit-cli start "Performance review: $1" --quiet)
cockpit-cli wait "$id1"
cockpit-cli wait "$id2"
echo "=== Security ===" && cockpit-cli result "$id1" -v response
echo "=== Performance ===" && cockpit-cli result "$id2" -v response
```

## Files Changed

| File | Change |
|------|--------|
| `bin/cockpit-cli` | Add `agents` (list) and `agent` (run) commands, agent discovery logic |
| `src/api-handlers.js` | Add `list-agents` handler (scans dirs, returns names + descriptions) |
| `skills/cockpit-sessions/agents.md` | Sub-skill doc teaching Claude how to use agents |
| `docs/agents.md` | User-facing documentation |

## Not Included (Future)

- **Agent templates/scaffolding** (`cockpit-cli agent-new <name>`) — manual creation is fine for now
- **Agent-specific pool settings** (dedicated slots, priority) — use regular pool slots
- **Agent marketplace/sharing** — just copy scripts for now
- **Argument schema/validation** — scripts handle their own args

## Open Questions

1. Should `cockpit-cli agent <name>` default to blocking (like `start --block`) or non-blocking (print ID, return immediately)? Non-blocking is more composable, but blocking is simpler for one-shot use.
2. Should the agent discovery API endpoint exist, or is CLI-only sufficient? (UI command palette would need the API.)
