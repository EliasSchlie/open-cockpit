# Pool Management

OC delegates pool management to the **claude-pool** daemon (`~/.claude-pool/<name>/api.sock`). Pool state is owned by claude-pool — OC has no local `pool.json`.

## Delegation Model

OC's `pool-manager.js` calls claude-pool via `claude-pool-client.js` for all pool operations:

- **init / resize / destroy** — pool lifecycle
- **start / followup** — send prompts to pool sessions
- **wait / capture** — observe session state
- **archive / health** — maintenance

OC still manages locally:
- **Offload metadata** (`offloaded/<sessionId>/`) — snapshots, meta.json, archived flag
- **Intentions** (`intentions/<session_id>.md`) — intention files
- **Session graph** (`session-graph.json`) — parent-child relationships
- **Settings UI**: Auto-refreshes every 3s. Clicking a slot row opens an interactive terminal popup attached to the live PTY.

## Plugin update → pool reinit

After pushing to `main`, CI auto-bumps the version and updates the marketplace. Claude Code's auto-update picks up the new version within 1–2 minutes. Pool sessions started before the update have stale hooks. To pick up new hooks:

1. Wait 1–2 minutes after push for CI + auto-update
2. Destroy the pool (`pool-destroy` via API or UI)
3. Re-initialize (`pool-init`)

New sessions will have the latest hooks.
