# Session Restore Across Daemon/Pool Restarts

## Problem

When the daemon crashes/restarts or the pool is destroyed+reinitialized, all active Claude sessions are lost. Users must manually resume each one.

## Design

### Single pipeline, two entry points

**Core function: `extractPendingRestore(pool)`**
- Reads pool.json slots
- Filters to non-fresh, non-dead, user-spawned sessions (skip `initiator: MODEL` from session graph)
- Writes `~/.open-cockpit/pending-restore.json` with session metadata
- Returns the list

**Entry point 1: `poolDestroy()`**
- Call `extractPendingRestore()` BEFORE killing slots and deleting pool.json
- Sessions get offloaded (snapshot saved) then killed as normal

**Entry point 2: `reconcilePool()` (daemon crash)**
- When ALL slots are dead (daemon crashed), call `extractPendingRestore()` BEFORE replacing slots
- No snapshot possible (daemon dead), but sessionIds + intentions survive
- Then proceed with normal reconcile (spawn fresh slots)

**Restore step: `poolInit()`**
- After spawning fresh slots and they're tracked, check for `pending-restore.json`
- For each entry, `/resume <claudeSessionId>` into a fresh slot
- Delete `pending-restore.json` after processing
- More sessions than slots → restore as many as fit, rest stay offloaded

### pending-restore.json format

```json
[
  { "sessionId": "abc-123", "claudeSessionId": "abc-123" },
  ...
]
```

### User vs agent distinction

Use session-graph.json: skip entries where `initiator === "MODEL"`. Sessions without graph entries default to user-spawned.

### Files touched

- `src/paths.js` — add `PENDING_RESTORE_FILE` constant
- `src/pool-manager.js` — `extractPendingRestore()`, modify `poolDestroy()`, `reconcilePool()`, `poolInit()`
