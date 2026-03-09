# Pool Management

The app manages a pool of pre-started Claude sessions. Pool state lives in `~/.open-cockpit/pool.json`.

## Operations

- **Init**: via UI or API (`pool-init` with size). Spawns Claude sessions via the PTY daemon using `resolveClaudePath()` (finds `claude` binary via `which` + fallback paths). Trust prompt is accepted via buffer polling (not hardcoded delay).
- **Dead/error slots**: `reconcilePool()` auto-restarts dead and error slots. Runs on startup and every 30s. Orphaned processes are killed via `killSlotProcess()` (daemon + PID fallback) before respawn.
- **Offloading**: Idle sessions get offloaded (snapshot + `/clear`). External `/clear` is also detected and saved as offloaded.
- **Archiving**: All dead sessions are auto-archived (`archived: true` in meta.json). Any session can be manually archived via right-click. Pool sessions auto-offload before archiving.
- **Destroy**: `pool-destroy` kills all slots and removes `pool.json`. Uses `killSlotProcess()` (daemon + PID fallback) to prevent orphans.
- **Write locking**: All pool.json read-modify-write cycles use `withPoolLock()` to prevent concurrent write races.
- **Settings UI**: Auto-refreshes every 3s. Clicking a slot row opens an interactive terminal popup attached to the live PTY.

## Plugin update → pool reinit

After pushing to `main`, CI auto-bumps the version and updates the marketplace. Claude Code's auto-update picks up the new version within 1–2 minutes. Pool sessions started before the update have stale hooks. To pick up new hooks:

1. Wait 1–2 minutes after push for CI + auto-update
2. Destroy the pool (`pool-destroy` via API or UI)
3. Re-initialize (`pool-init`)

New sessions will have the latest hooks.
