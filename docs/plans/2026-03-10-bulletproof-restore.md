# Bulletproof Session Restore

## Problem

Sessions are lost when the app crashes or is killed because:
1. `extractPendingRestore()` only runs on explicit `poolDestroy()` or when `reconcilePool()` detects ALL slots dead — a partial crash or hard kill skips it
2. `pending-restore.json` is transient — if the process is killed mid-restore, the file may be consumed but restoration incomplete
3. `restorePendingSessions()` only triggers from `poolInit()` or `reconcilePool()` (all-dead case) — a new instance attaching to an existing pool never tries to restore
4. `claudeSessionId` is only persisted on offload — if the app dies before offloading, we can't resume

## Design: Continuous Session Registry

Instead of saving session state only at destruction time, **continuously maintain a registry** of all active sessions and their Claude session IDs.

### New file: `~/.open-cockpit/active-sessions.json`

```json
{
  "cf32676d-...": { "claudeSessionId": "cf32676d-...", "cwd": "/Users/mee/projects/foo", "slotIndex": 0 },
  "7483d481-...": { "claudeSessionId": "7483d481-...", "cwd": "/Users/mee/projects/bar", "slotIndex": 3 }
}
```

Updated whenever:
- A slot transitions to BUSY/IDLE/TYPING (session becomes active) → add entry
- A slot is offloaded/cleared → remove entry
- A slot dies → entry stays (that's the point)

### Restore on startup

In `reconcilePool()` (runs at startup + every 30s):
1. Read `active-sessions.json`
2. Compare against live pool slots
3. Any session in the registry but NOT in a live slot → needs restore
4. Resume those sessions into fresh slots (same as `restorePendingSessions()`)
5. Remove restored entries from registry (they get new slot assignments)

### What this fixes

- **Hard kill**: Registry was written continuously, so all active sessions are recorded
- **Partial crash**: Only dead sessions get restored, live ones stay
- **Daemon crash**: Same — registry persists across daemon restarts
- **Mid-restore kill**: On next startup, unrestored sessions are still in registry
- **No `pending-restore.json` needed**: The registry replaces it entirely

### Migration

- Keep `extractPendingRestore()` and `restorePendingSessions()` working for one release (read old format, migrate to registry)
- Then remove in next release

## Implementation

1. Add `ACTIVE_SESSIONS_FILE` to `paths.js`
2. Add `updateActiveRegistry()` — called from `trackNewSlot()` `onResolved` callback and status change handlers
3. Add `removeFromActiveRegistry(sessionId)` — called from offload/clear/archive
4. Modify `reconcilePool()` to check registry and restore missing sessions
5. Remove `pending-restore.json` dependency (keep as fallback initially)
