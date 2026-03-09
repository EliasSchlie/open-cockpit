# Pool Management

The app manages a pool of pre-started Claude sessions. Pool state lives in `~/.open-cockpit/pool.json`.

## Slot lifecycle

Each slot moves through: `STARTING` → `IDLE` → `BUSY` → `IDLE` → (offloaded/archived).

- **Init**: `pool-init` spawns Claude sessions via the PTY daemon using `resolveClaudePath()`. Trust prompt is accepted via buffer polling (not hardcoded delay).
- **Claiming**: `withFreshSlot()` claims an idle slot for a new task. Uses an async queue to serialize concurrent claims, preventing two `cockpit-cli start` calls from grabbing the same slot.
- **Offloading**: Idle sessions get offloaded (snapshot saved + `/clear` sent) to free slots. External `/clear` is also detected and saved.
- **Archiving**: Dead sessions are auto-archived (`archived: true` in meta.json). Any session can be manually archived via right-click.
- **Destroy**: `pool-destroy` kills all slots and removes `pool.json`. Uses `killSlotProcess()` (daemon + PID fallback).

## Reconciliation

`reconcilePool()` runs on startup and every 30s:
- Restarts dead and error slots
- Recreates missing idle signals for fresh sessions
- Kills orphaned processes before respawn
- Syncs slot statuses with actual session states

## Fresh slot pre-warming

`preWarmPool()` runs on a 30s interval. When the number of fresh (unclaimed) slots drops below `minFreshSlots` (configurable in pool settings, default 1):
1. Collects all offload targets in a single locked pass via `findOffloadTargets()`
2. Executes offloads outside the lock to free slots
3. Reconcile then respawns the freed slots

## Pinning

Slots can be pinned (`pinnedUntil` timestamp) to prevent offloading. Pinned slots are skipped by `findOffloadTarget()` and `selectShrinkCandidates()`. Pinning protects sessions that are idle but should be kept alive (e.g., sessions with ongoing context the user wants to return to).

## Write locking

All pool.json read-modify-write cycles use `withPoolLock()` (async mutex in `pool-lock.js`) to prevent concurrent write races. Always `await` the lock — unawaited calls cause state corruption.

## Settings

`~/.open-cockpit/pool-settings.json` stores:
- `flags` — CLI flags passed to `claude` on session start
- `minFreshSlots` — target number of unclaimed slots to maintain (default 1, max 10)

Settings UI auto-refreshes every 3s. Clicking a slot row opens an interactive terminal popup.

## Plugin update → pool reinit

After pushing to `main`, CI auto-bumps the version and updates the marketplace. Claude Code's auto-update picks up the new version within 1–2 minutes. Pool sessions started before the update have stale hooks. To pick up new hooks:

1. Wait 1–2 minutes after push for CI + auto-update
2. Destroy the pool (`pool-destroy` via API or UI)
3. Re-initialize (`pool-init`)

## Key files

| File | Role |
|------|------|
| `src/pool.js` | Pure data structures: read/write pool, health computation, offload target selection |
| `src/pool-manager.js` | Pool lifecycle: init, reconcile, offload, archive, pre-warm, claim |
| `src/pool-lock.js` | Async mutex for pool.json |
| `src/pool-ui.js` | Settings panel, slot terminal popup |
