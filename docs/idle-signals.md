# Idle Signals

Idle signals tell the app when a Claude session is waiting for user input vs actively processing. They drive sidebar status badges, bell notifications, and pool offload decisions.

**Location:** `~/.open-cockpit/idle-signals/<PID>`

## Why they exist

Claude Code has no built-in "am I idle?" API. The app detects idle state by writing signal files from plugin hooks that fire at key lifecycle points. The signal file's presence means "this session is idle" — its absence means "processing."

**No false positives.** The app may trigger notifications (bell) on idle transitions. A premature idle signal is worse than a delayed one.

## Signal file format

```json
{"cwd":"/path/to/project","session_id":"uuid","transcript":"/path/to/file.jsonl","ts":1234567890,"trigger":"stop"}
```

| Field | Description |
|-------|-------------|
| `cwd` | Working directory at signal time |
| `session_id` | Claude session UUID (used to discard stale signals from PID reuse) |
| `transcript` | Path to JSONL transcript (used for deferred verification) |
| `ts` | Unix timestamp (seconds) |
| `trigger` | What caused the signal: `stop`, `tool`, `permission`, `pool-init`, `session-clear`, `resume` |

## Lifecycle

```
                   UserPromptSubmit / PostToolUse
                          │
                          ▼
                    ┌───────────┐
                    │  CLEARED  │ ← signal file + .pending deleted
                    └─────┬─────┘
                          │
                    Claude processes...
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
         Stop hook   PreToolUse   PermissionRequest
       (deferred)    (immediate)   (immediate)
              │           │           │
              ▼           ▼           ▼
         .pending     signal file  signal file
         created      written      written
              │
         wait 4s (system entries)
         wait 3s (verify size)
              │
         size unchanged?
          yes │    no
              ▼    ▼
         signal  abort
         written (not idle)
```

## Actors

### 1. Hook script (`hooks/idle-signal.sh`)

The primary signal writer/clearer. Called by Claude Code at hook events.

| Hook Event | Matcher | Action | Detail |
|------------|---------|--------|--------|
| `Stop` | — | deferred write | Waits 4s + 3s, verifies transcript size unchanged |
| `PreToolUse` | `AskUserQuestion\|ExitPlanMode` | immediate write | Also clears any `.pending` file |
| `PermissionRequest` | — | immediate write | Also clears any `.pending` file |
| `PostToolUse` | — | clear | Deletes signal + `.pending` |
| `UserPromptSubmit` | — | clear | Deletes signal + `.pending` |
| `SessionStart` | `clear` | write (`session-clear`) | Session was `/clear`'d, marks fresh |

### 2. Pool manager (`src/pool-manager.js`)

Creates synthetic signals for pool-managed sessions that bypass the normal hook flow.

- **`createFreshIdleSignal(pid, sessionId)`** — writes a signal with `trigger: "pool-init"`. Called when:
  - A new pool slot finishes spawning (session ID resolved)
  - `reconcilePool()` detects a fresh slot missing its signal (lost on app restart)
  - `reconcilePool()` finds a slot whose session ID changed (external `/clear`)
- **`offloadSession()`** — deletes the idle signal after sending `/clear`, so the slot re-detects as fresh
- **`poolResume()`** — writes a signal with `trigger: "resume"` after `/resume` completes (the Stop hook won't fire since there's no assistant turn)

### 3. Session discovery (`src/session-discovery.js`)

Reads signals to classify session status. Never writes them.

- **`getIdleSignal(pid)`** — reads `~/.open-cockpit/idle-signals/<PID>`, returns parsed JSON or null
- **Status classification logic:**
  - Signal present + activated or has assistant turns → `idle`
  - Signal present + never activated, no assistant turns → `fresh` or `typing`
  - Signal absent + alive → `processing` (with stale fallback)
  - Signal absent + dead → `dead`
- **Stale signal validation** — discards signals where `session_id` doesn't match the current session (PID reuse protection)

### 4. Stale signal cleanup (`cleanupStaleIdleSignals()` in pool-manager.js)

Runs periodically. Removes signal files where:
- The PID is dead (process exited)
- The PID has no corresponding `session-pids/<PID>` entry

## The `.pending` file mechanism

The `stop` trigger can't write immediately — another Stop hook might re-prompt Claude, making it not actually idle. The `.pending` file coordinates this:

1. **Stop hook fires** → writes `$$` (shell PID) to `<signal_file>.pending`
2. **Background subshell** spawns (`disown`'d):
   - Waits `SYSTEM_ENTRY_WAIT` (4s) for Claude to finish writing system entries (`stop_hook_summary`, `turn_duration`) — these happen concurrently with async hooks
   - Checks `.pending` still exists and contains our PID (not invalidated)
   - Records transcript file size
   - Waits `IDLE_VERIFY_DELAY` (3s)
   - Re-checks `.pending` (TOCTOU protection)
   - Compares transcript size — if it grew, a re-prompt happened → abort
   - If everything checks out, writes the signal file
3. **Invalidation** — any of these delete `.pending`, aborting the deferred write:
   - `PostToolUse` → `clear` (processing resumed)
   - `UserPromptSubmit` → `clear` (user sent new input)
   - Another `Stop` hook → overwrites `.pending` with its own PID
   - Immediate write (`tool`/`permission`) → deletes `.pending` before writing signal

**Why file size, not mtime?** Claude keeps the JSONL file handle open, causing periodic mtime updates without new content. Size only changes when actual entries are appended.

## Stale processing fallback (`STALE_PROCESSING_MS`)

If a session has no idle signal but its JSONL transcript size hasn't changed in 5 minutes, session-discovery treats it as idle. This catches cases where the hook failed entirely.

- Uses file size tracking (`jsonlSizeTracker` map) — not mtime
- Pool sessions with no `"type":"user"` entries are excluded (genuinely fresh, just missing their pool-init signal)
- Always logs to stderr when triggered — stale detection indicates a hook failure

## Activation tracking

Sessions track whether they've been through a real processing cycle via an in-memory `activatedSessions` Set.

- A session is "activated" when it has an idle signal with a trigger **not** in `FRESH_TRIGGERS` (`pool-init`, `session-clear`)
- Activated sessions always classify as `idle` or `processing`, never `fresh`/`typing`
- Prevents misclassification after `/resume` or `/clear` when transcript checks are unreliable

## Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Session stuck in "processing" | Idle signal hook didn't fire (hook error, plugin not installed) | Check `~/.claude/plugins/` for the plugin. Inspect hook stderr. Signal will self-correct after `STALE_PROCESSING_MS` (5 min). |
| Session stuck in "processing" after resume | `poolResume()` didn't write the resume signal | Bug — the resume signal write should happen in `onResolved` callback |
| False "idle" after PID reuse | Old signal file from previous session on same PID | `getIdleSignal()` checks `session_id` field — mismatches are discarded. `cleanupStaleIdleSignals()` removes signals for dead PIDs. |
| Bell fires during processing | Hook wrote signal prematurely (false positive in deferred verification) | Check if `SYSTEM_ENTRY_WAIT` or `IDLE_VERIFY_DELAY` are too short. Transcript size comparison should catch re-prompts. |
| Fresh pool slot shows as "processing" | Signal lost on app restart or hook race | `reconcilePool()` recreates missing pool-init signals for fresh slots |
| Stale detection logs flooding stderr | Hook consistently failing for a session | Fix the hook. Stale detection is a fallback, not normal operation. |

## Debugging

```bash
# List all idle signals
ls -la ~/.open-cockpit/idle-signals/

# Read a specific signal
cat ~/.open-cockpit/idle-signals/<PID>

# Check for pending deferred writes
ls ~/.open-cockpit/idle-signals/*.pending

# Compare signal age with transcript
cat ~/.open-cockpit/idle-signals/<PID>  # note ts field
stat -f "mtime=%m" <transcript_path>    # compare timestamps

# Check if hook is installed
cat ~/.claude/plugins/installed_plugins.json | grep open-cockpit
```
