# Sessions

## Lifecycle

```
fresh → typing → processing → idle → offloaded (graceful /clear, snapshot saved)
  ↑       ↓                     ↓         ↓
  └───────┘                   dead    archived (manual or auto)
                                ↓
                            archived (auto on death)
```

- **fresh** — pool slot with Claude ready, no user interaction yet
- **typing** — fresh session where user has typed text in the editor (shown in sidebar, excluded from offload/resume targets)
- **processing** — Claude is actively working
- **idle** — Claude finished, waiting for user input
- **offloaded** — session `/clear`'d, conversation saved (meta.json + snapshot.log), slot reused
- **dead** — Claude process exited unexpectedly
- **archived** — stored session (meta.json `archived: true`), shown in Archive section, resumable

## Idle detection

See [idle-signals.md](idle-signals.md) for the full lifecycle, actors, `.pending` mechanism, stale fallback, activation tracking, and failure modes.

Key invariants:
- **Idle signal = idle.** The app trusts the signal file directly — no mtime/size cross-checks.
- **No false positives.** Premature "idle" is worse than delayed — triggers notifications.
- **Activation tracking** prevents fresh/typing misclassification after `/resume` or `/clear`.

## Archiving

- **Auto-archive**: Dead sessions with an intention heading are auto-archived. Sessions that were never used (no intention, no snapshot) are silently discarded to avoid archive spam.
- **Manual archive**: Right-click any session → "Archive". Pool sessions are auto-offloaded (snapshot + `/clear`) before archiving.
- **Sidebar**: Archive section appears below Processing. Archived sessions are dimmed.
- **Resume**: Click an archived session → "Restart" button or right-click → "Restart". Acquires a fresh pool slot, runs `/resume <claudeSessionId>`, creates a new session with a new ID.
- **Resume flow** (spans pool-manager.js → renderer.js):
  1. `poolResume(oldId)`: claims fresh slot inside `withPoolLock`, sends `/resume`, clears `slot.sessionId`, writes pool
  2. After lock releases: removes offload data immediately (prevents stale "offloaded" entry in sidebar)
  3. `trackNewSlot` polls in background until Claude's `SessionStart` hook writes the new session ID
  4. Renderer's `pollForResumedSession` polls pool.json for the slot's new session ID
  5. Once resolved: renderer updates `state.currentSessionId`, re-tags terminals, reloads intention file + watcher
- **Unarchive**: Right-click archived session → "Move to Recent" moves it back to offloaded (no restart).
- **Data**: `archived: true` flag in `~/.open-cockpit/offloaded/<id>/meta.json`.

## Session graph (parent-child tracking)

Sessions track who started them and parent-child relationships in `~/.open-cockpit/session-graph.json`:
- **initiator**: `"user"` (human via UI/terminal) or `"model"` (Claude via `cockpit-cli start` or Agent tool)
- **parentSessionId**: the session that spawned this one (null for top-level)
- **Auto-detection**: `enrichSessionsWithGraphData()` walks PPID chain for sessions without graph entries, auto-detects parent from `session-pids/` mappings, and persists the relationship. Works for all sub-agent types (Agent tool, cockpit-cli, external).
- CLI also detects parent by walking PPID chain → `~/.open-cockpit/session-pids/`
- API: `pool-start` accepts optional `parentSessionId`; `get-session-graph` returns the full graph
- `get-sessions` response enriched with `parentSessionId` and `initiator` fields
- **Child session archiving**: Dead child sessions are NOT independently auto-archived — they stay under their parent and only get archived when the parent is archived (depth-first cascade)

## Session pinning

Pool slots can be pinned to prevent LRU offloading:
- `pool-pin { sessionId, duration }` — pin for N seconds (default 120)
- `pool-unpin { sessionId }` — release pin
- `pinnedUntil` field in pool.json slots; expired pins auto-cleared on eviction check
- CLI: `cockpit-cli pin <id> [seconds]` / `cockpit-cli unpin <id>`

## Origin tags

Sessions in the sidebar display an origin tag:
- **pool** (green) — spawned by the pool manager (`OPEN_COCKPIT_POOL=1` env var)
- **custom** (cyan) — standalone sessions spawned via Cmd+Shift+N (`OPEN_COCKPIT_CUSTOM=1` env var)
- **sub-claude** (purple) — spawned by sub-claude (`SUB_CLAUDE=1` env var)
- **ext** (gray) — external sessions (no known env markers)

Detection uses `ps eww <PID>` to read process environment. Results are cached by PID.

## Custom sessions

Standalone Claude sessions spawned via `Cmd+Shift+N`. Unlike pool sessions, custom sessions:
- Are **not part of the pool** — they don't occupy pool slots or get offloaded/recycled
- Run on the PTY daemon (like pool sessions) but are tracked independently
- Show a **custom** (cyan) origin tag in the sidebar
- Are **fully killed** on archive (PTY terminated), not just cleared
- Support custom working directory and extra CLI flags (e.g. `--model sonnet`)

The dialog prompts for a working directory (default: `~`) and optional flags. The session spawns Claude with `--dangerously-skip-permissions` plus any extra flags.

## Debugging session state

Inspect actual runtime data first — don't hypothesize from code alone:
```bash
# List sessions with PID, TTY, command, alive status
for f in ~/.open-cockpit/session-pids/*; do pid=$(basename "$f"); echo "PID=$pid TTY=$(ps -p $pid -o tty= 2>/dev/null) COMM=$(ps -p $pid -o comm= 2>/dev/null) SID=$(cat $f | head -c 12)..."; done
# Check idle signals
ls -la ~/.open-cockpit/idle-signals/
# Check if transcript mtime is newer than idle signal (false processing?)
cat ~/.open-cockpit/idle-signals/<PID>  # get transcript path
stat -f "mtime=%m" <transcript_path>    # compare with signal mtime
```
