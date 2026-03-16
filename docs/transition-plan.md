# Transition Plan: Open Cockpit → claude-pool + claude-term

> **Goal:** Replace OC's background daemon logic (PTY daemon, pool manager, idle detection, session state machine) with claude-pool and claude-term as external dependencies. OC becomes a pure Electron frontend: window management, UI rendering, intention files, and socket clients to two external daemons.

## Summary

OC currently runs its own PTY daemon and pool management logic in-process. After transition:

- **claude-pool** handles all pool/session lifecycle: spawn, offload, resume, eviction, idle detection, state tracking, PTY I/O for Claude TUI sessions
- **claude-term** handles all non-Claude terminals: shell tabs, ephemeral exec tabs, persistent terminal management
- **OC keeps:** intention files, external session discovery (non-pool), hooks (intention-related), UI rendering, window management, custom agents, dev instances
- **Multi-pool:** OC discovers and manages all running pools on the machine via `claude-pool pools`
- **Custom sessions (Cmd+Shift+N):** replaced by multiple pools with different configurations

## Spec gaps

### Resolved

**1. ~~Session PTY resize~~ → `pty-resize` API command (PR #53)**

claude-pool now has `pty-resize` (sessionId, cols, rows) in the UI-specific API. Triggers SIGWINCH. `attach` response includes current `cols`/`rows`.

**2. ~~Initial PTY dimensions~~ → client-driven resize**

No pool-level dimension config needed. OC calls `pty-resize` after `attach` to match its viewport. Last resize wins.

**3. ~~No explicit offload command~~ → `archive` suffices**

`archive` stops processing sessions first and offloads idle sessions first (PR #53). OC's "clean up" can just archive idle sessions. No separate offload command needed.

**4. ~~archive on processing sessions~~ → spec clarified (PR #53)**

archive now explicitly stops processing, offloads idle, and is idempotent.

### Open

**5. claude-term: No `run` operation (terminal command execution)**

OC's `session-term-run` sends a command to a shell tab, waits for the shell prompt to reappear, and returns output. Heavily used by Claude sessions via `cockpit-cli term run`. claude-term's spec only has `write` + `read`.

**Options:**
- (a) Add `run` to claude-term spec — other consumers benefit too
- (b) Implement polling logic in OC's layer (wrapping claude-term write+read)

---

## Module-by-module transition

### Deleted from OC (replaced entirely)

| OC module | Replacement | Notes |
|-----------|-------------|-------|
| `src/pty-daemon.js` | claude-term | OC no longer runs its own PTY daemon |
| `src/pool-manager.js` | claude-pool | All pool lifecycle moves to claude-pool daemon |
| `src/pool.js` | claude-pool | Pool data structures gone (no more pool.json) |
| `src/pool-lock.js` | claude-pool | No more pool.json → no more write locking |
| `src/daemon-client.js` | New: claude-pool + claude-term socket clients | Two socket connections instead of one |

### Simplified in OC

| OC module | Change |
|-----------|--------|
| `src/session-discovery.js` | Only discovers *external* sessions. Pool session state comes from `claude-pool subscribe`. Remove idle-signal polling, pool slot reconciliation. |
| `src/api-server.js` | Many commands become pass-through to claude-pool/claude-term. Pool commands, slot commands, PTY commands all proxy. Session/intention/window/agent commands stay in OC. |
| `src/api-handlers.js` | Same — pool handlers become thin proxies, OC-specific handlers stay. |
| `src/session-statuses.js` | Map claude-pool statuses (`idle`, `processing`, `offloaded`, `queued`, `archived`, `error`) to OC display states. OC's `typing` derived from `status=idle` + `pendingInput != ""`. OC's `fresh` derived from `status=idle` + no Claude UUID history / promptless start. |
| `src/parse-origins.js` | Pool sessions get origin from which pool they belong to. External session detection via `ps eww` stays for non-pool sessions. |
| `src/terminal-input.js` | May be removable — `pendingInput` detection now handled by claude-pool's buffer polling. |

### Unchanged in OC

| Module | Why it stays |
|--------|-------------|
| `src/main.js` | Window management, IPC wiring (simplified) |
| `src/preload.js` | Context bridge |
| `src/renderer.js` | Session lifecycle, auto-save, IPC wiring |
| `src/dock-layout.js` | Dock system |
| `src/dock-helpers.js` | Dock utilities, terminal resize |
| `src/editor.js` | CodeMirror editor |
| `src/session-sidebar.js` | Session list rendering |
| `src/terminal-manager.js` | Terminal creation, attach, switch (now talks to claude-pool for TUI, claude-term for shells) |
| `src/pool-ui.js` | Pool settings panel (now shows all pools, talks to claude-pool) |
| `src/command-palette.js` | Commands registry |
| `src/session-search.js` | Session search |
| `src/session-stats.js` | JSONL parsing, token stats |
| `src/agent-picker.js` | Agent picker |
| `src/stats-ui.js` | Session info dialog |
| `src/shortcuts.js` | Keyboard shortcuts |
| `src/sort-sessions.js` | Session ordering |
| `src/secure-fs.js` | File helpers |
| `src/platform.js` | Cross-platform abstraction |

---

## Detailed feature mapping

### Pool lifecycle

| OC action | Before (OC internal) | After (claude-pool) |
|-----------|---------------------|---------------------|
| Init pool | `pool-init` → spawns PTY processes, writes pool.json | `claude-pool init --size N --flags "..." --keep-fresh 1` |
| Destroy pool | `pool-destroy` → kills processes, removes pool.json | `claude-pool destroy --confirm` |
| Resize | `pool-resize` → adds/removes slots | `claude-pool resize --size N` |
| Health | `pool-health` → computes from pool.json | `claude-pool health` |
| Config | pool-settings.json | `claude-pool config --set key=value` |
| Reconcile dead slots | 30s timer in pool-manager | claude-pool handles internally (slot error → auto-recycle) |

### Session interaction

| OC action | Before | After |
|-----------|--------|-------|
| Cmd+N (new session) | Grab fresh pool slot | `claude-pool start` (no prompt) → `attach` for TUI |
| Cmd+Shift+N (custom session) | Spawn standalone Claude with custom flags | Pick pool → `claude-pool start --pool <name>` (no prompt) |
| Send prompt (from editor) | `pool-followup` → write to PTY via daemon | `claude-pool followup --session <id> --prompt <text>` |
| Send prompt (type in TUI) | User types directly in attached TUI | Same — keystrokes go through `attach` pipe |
| Wait for result | `pool-wait` → polls idle signals | `claude-pool wait --session <id>` |
| Capture output | `pool-capture` → reads PTY buffer | `claude-pool capture --session <id>` |
| Stop/interrupt | Escape key via PTY | `claude-pool stop --session <id>` |
| Archive | `archive-session` → offload + set archived flag | `claude-pool archive --session <id>` |
| Unarchive | `unarchive-session` → clear archived flag | `claude-pool unarchive --session <id>` |
| Resume (restart archived) | `pool-resume` → `/resume <uuid>` in fresh slot | `claude-pool unarchive` then `claude-pool followup --session <id> --prompt <text>` (or no prompt for interactive resume) |
| Pin | `pool-pin` → set pinnedUntil in pool.json | `claude-pool set --session <id> --pinned <seconds>` |
| Offload idle sessions | `pool-clean` → offload all idle | `claude-pool archive --session <id>` per idle session |

### Terminal tabs

| Tab type | Before | After |
|----------|--------|-------|
| Claude TUI (pool session) | Attach to OC PTY daemon terminal | `claude-pool attach --session <id>` → raw PTY pipe |
| Shell tab (pool session) | Spawn via OC PTY daemon, tagged with sessionId | `claude-term spawn` with owner=`<session-id>` |
| Shell tab (external session) | Spawn via OC PTY daemon | `claude-term spawn` with owner=`<session-id>` |
| "+" button (new shell) | `session-term-open` → spawn at session cwd | `claude-term spawn --cwd <path> --owner <session-id>` |
| Close shell tab | `session-term-close` → kill PTY | `claude-term kill <terminal-id>` |
| Terminal exec (ephemeral) | `session-term-run` → poll for prompt | `claude-term run` (if added to spec), or OC implements polling wrapper over write+read |

### Session terminal mapping

OC currently tracks which PTY terminals belong to which session via `set-session` on its daemon. After transition:

- **Claude TUI:** owned by claude-pool. OC gets access via `claude-pool attach`.
- **Shell tabs:** owned by claude-term. OC sets `owner=<session-id>` on spawn and uses `claude-term list --owner <session-id>` to enumerate.
- **Mapping stored in OC's renderer state** (not persisted — reconstructed on startup from claude-term's owner data + claude-pool's session list).

### Idle detection

| Before | After |
|--------|-------|
| Idle signal files (`~/.open-cockpit/idle-signals/`) | claude-pool `subscribe` events (status transitions) |
| Poll idle signals every 2s | Subscribe once, receive push events |
| `session-discovery.js` classifies each session | claude-pool reports status directly |
| Trust-the-signal-file invariant | Not needed — claude-pool handles idle detection internally |

For **external sessions only**: OC keeps its idle-signal hooks and polling logic. But this is a much smaller scope (only non-pool sessions the user happened to start outside OC).

### Session state mapping

| OC status | claude-pool equivalent | How OC derives it |
|-----------|----------------------|-------------------|
| `fresh` | `idle` (promptless) | `status=idle` + session was started without prompt (metadata or creation pattern) |
| `typing` | `idle` + pendingInput | `status=idle` + `pendingInput != ""` |
| `processing` | `processing` | Direct |
| `idle` | `idle` | `status=idle` + `pendingInput == ""` + has been prompted before |
| `offloaded` | `offloaded` | Direct |
| `dead` | (becomes `offloaded`) | claude-pool auto-transitions dead → offloaded |
| `archived` | `archived` | Direct |
| `queued` | `queued` | Direct (new — OC didn't have this) |
| `error` | `error` | Direct (new — OC showed these as dead) |

### Hooks

| Hook | Before | After |
|------|--------|-------|
| `session-pid-map.sh` (SessionStart) | Maps PID → session ID for all Claude sessions | **Keep for external sessions only.** Pool sessions are tracked by claude-pool. |
| `session-intention-intro.sh` (UserPromptSubmit) | Introduces intention file to Claude | **Keep unchanged.** Intention files stay in OC. |
| `intention-change-notify.sh` (UserPromptSubmit) | Surfaces intention file diffs | **Keep unchanged.** |
| `idle-signal.sh` (multiple triggers) | Writes idle signal files | **Remove for pool sessions** (claude-pool detects idle internally). **Keep for external sessions only** if OC still shows external session status. |

claude-pool and claude-term install their **own hooks** independently. OC's hooks coexist — Claude Code supports multiple hook sources (plugin hooks + pool daemon hooks + term daemon hooks).

### Multi-pool support

OC currently manages one pool. After transition, it sees all pools on the machine.

**Discovery:** `claude-pool pools` returns all registered pools with status (running/stopped).

**UI changes:**
- Sidebar groups sessions by pool name (e.g., "default", "sonnet-pool", "research")
- Pool settings panel shows all pools in a list, each expandable for config/health
- Cmd+N → starts a session in the currently selected pool (or default)
- Cmd+Shift+N → pool picker dialog: select pool, or create new pool with custom flags
- Pool init/destroy/resize controls per pool in settings

**Session listing:** OC calls `claude-pool ls` on each running pool and merges results. The `subscribe` event stream is opened per-pool.

### Custom sessions replacement

| Before | After |
|--------|-------|
| Cmd+Shift+N → dialog (cwd, flags) → spawn standalone Claude | Cmd+Shift+N → pool picker (existing pools + "New pool") |
| Custom sessions tracked independently, cyan origin tag | Each pool has its own color/label in sidebar |
| Custom sessions killed on archive | Pool sessions follow normal pool lifecycle |
| Mixed flags in same view | Each pool is uniform (invariant #3) — different flags = different pool |

### cockpit-cli

The CLI remains OC's external interface. Command mapping:

| cockpit-cli command | Before (OC API) | After |
|---------------------|-----------------|-------|
| `ls` | `get-sessions` | Merge: `claude-pool ls` (per pool) + external discovery |
| `start` | `pool-start` | `claude-pool start --prompt <text>` |
| `followup` | `pool-followup` | `claude-pool followup --session <id> --prompt <text>` |
| `wait` | `pool-wait` | `claude-pool wait` |
| `capture` / `screen` | `pool-capture` | `claude-pool capture --source buffer` |
| `result` | `pool-result` | `claude-pool capture --source jsonl` |
| `stop` | Escape via PTY | `claude-pool stop --session <id>` |
| `resume` | `pool-resume` | `claude-pool unarchive` + `claude-pool followup` |
| `archive` | `archive-session` | `claude-pool archive --session <id>` |
| `input` | `pool-input` | `claude-pool debug input` |
| `clean` | `pool-clean` | `claude-pool offload` per idle session |
| `pin` / `unpin` | `pool-pin` / `pool-unpin` | `claude-pool set --pinned` |
| `slot read/write/status` | `slot-*` | `claude-pool debug capture/input/slots` |
| `pool init/status/resize/destroy` | `pool-*` | `claude-pool init/health/resize/destroy` |
| `term *` | `session-term-*` via OC API | `claude-term *` (with owner mapping) |
| `intention` | `read-intention` / `write-intention` | Stays in OC API |
| `agents` / `agent` | `list-agents` via OC API | Stays in OC API |
| `show/hide/screenshot` | Window control via OC API | Stays in OC API |
| `watch` / `log` | OC API | OC proxies to claude-pool capture/subscribe |

**Open question:** Should `cockpit-cli` talk to OC's API (which proxies to claude-pool/claude-term), or should it talk directly to claude-pool/claude-term for pool/terminal commands? Proxying keeps one entry point. Direct access is simpler but means cockpit-cli needs to know about multiple sockets.

**Recommendation:** Keep OC API as the single entry point. cockpit-cli talks only to `~/.open-cockpit/api.sock`. OC proxies pool and terminal commands internally. This preserves the "one API to rule them all" pattern and keeps OC-specific features (intention files, agents, window control, session merging) integrated.

### Dev instances

Dev instances continue to work. The `OPEN_COCKPIT_DIR` scoping mechanism is independent of where pool/terminal daemons run. Dev instances would:
- Connect to the same claude-pool/claude-term daemons as the base instance (shared pools, shared terminals)
- Or run their own pools (via `--pool dev-<session-id>`)

**Decision needed:** Should dev instances share pools with the base instance, or create isolated pools? Sharing is simpler. Isolated is safer for testing.

### Debug logging

OC's `debug.log` continues for OC-specific logging (renderer events, UI decisions). Pool-level logs move to `claude-pool debug logs`. Terminal-level logs are in claude-term's daemon.

### Origin tags

| Before | After |
|--------|-------|
| **pool** (green) — `OPEN_COCKPIT_POOL=1` env | Session belongs to a pool → show pool name + color |
| **custom** (cyan) — `OPEN_COCKPIT_CUSTOM=1` env | Gone — custom sessions are now pool sessions in a user-created pool |
| **sub-claude** (purple) — `SUB_CLAUDE=1` env | Derived from `parent` field in claude-pool |
| **ext** (gray) — no known markers | Same — external discovery logic unchanged |

### Parent-child sessions

| Before | After |
|--------|-------|
| `session-graph.json` in OC | claude-pool tracks parent-child via `--parent` flag |
| PPID-chain auto-detection | claude-pool does the same (env-based auto-detection) |
| `enrichSessionsWithGraphData()` | Not needed — claude-pool's `ls --verbosity nested` returns the tree |
| Cascade archive | `claude-pool archive --session <id> --recursive` |

### Intention files

No change. OC reads/writes `~/.open-cockpit/intentions/<session_id>.md`. The hooks that introduce intention files to Claude sessions stay in OC's plugin. Intention files are pure OC — neither claude-pool nor claude-term needs to know about them.

Intention files remain keyed by **Claude UUID** (not claude-pool's internal session ID). Claude UUID is the universal identifier that works for both pool and external sessions. For pool sessions, OC maps `sessionId` → `claudeUUID` via `claude-pool info`.

### TUI attach workflow

The critical path for displaying a Claude session's TUI in OC:

**Before:**
1. OC PTY daemon owns the Claude process
2. Renderer sends `attach` to daemon → gets replay buffer + live output stream
3. xterm.js writes buffer at matching dimensions (avoids reflow garbling)
4. Resize: clear xterm buffer, call `ptyResize` on daemon, SIGWINCH triggers Claude redraw

**After:**
1. `claude-pool attach` → get pipe socket path + current PTY dimensions (`cols`, `rows`)
2. Create xterm.js at those dimensions, connect to pipe socket, write replay buffer (prevents reflow garbling)
3. `claude-pool pty-resize` to match actual viewport if different from reported dims
4. On window/pane resize → clear xterm buffer, `pty-resize` with new dims, SIGWINCH triggers Claude redraw

The `attachPoolTerminal` strategy (fetch dims, create xterm at those dims, write buffer) transfers directly. Dimensions are now client-driven — the pool has no default dimension config. Last resize wins, so multiple OC instances viewing the same session work correctly (the actively viewing one controls dimensions).

The `session-pid-map.sh` hook must fire for **all** sessions (pool and external), not just external. The intention hooks (`session-intention-intro.sh`, `intention-change-notify.sh`) resolve session ID via PID mapping, so pool sessions need it too.

### Data directory changes

| Before | After |
|--------|-------|
| `~/.open-cockpit/pool.json` | Gone — claude-pool owns pool state |
| `~/.open-cockpit/pool-settings.json` | Gone — `claude-pool config` |
| `~/.open-cockpit/session-pids/<PID>` | Keep for external sessions. Pool sessions tracked by claude-pool. |
| `~/.open-cockpit/pool-spawned-pids/<PID>` | Gone — claude-pool manages process lifecycle |
| `~/.open-cockpit/idle-signals/<PID>` | Keep for external sessions only. Pool sessions use subscribe. |
| `~/.open-cockpit/session-graph.json` | Gone — claude-pool tracks parent-child |
| `~/.open-cockpit/offloaded/<id>/` | Gone — claude-pool manages offload data |
| `~/.open-cockpit/active-sessions.json` | Gone — claude-pool + external discovery |
| `~/.open-cockpit/intentions/<id>.md` | **Keep** — OC's core feature |
| `~/.open-cockpit/shortcuts.json` | **Keep** |
| `~/.open-cockpit/agents/` | **Keep** |
| `~/.open-cockpit/setup-scripts/` | **Keep** |
| `~/.open-cockpit/colors.json` | **Keep** |
| `~/.open-cockpit/debug.log` | **Keep** |
| `~/.open-cockpit/api.sock` | **Keep** — OC's own API socket |
| `~/.open-cockpit/pty-daemon.sock` | Gone — claude-term at `~/.claude-term/daemon.sock` |
| `~/.open-cockpit/pty-daemon.pid` | Gone |

---

## Implementation phases

### Phase 0: Spec amendments
~~Resolve spec gaps.~~ Done — gaps 1-4 resolved in claude-pool PRs #47, #53, #54. Only gap 5 (claude-term `run`) remains open.

### Phase 1: claude-pool as pool backend
- Replace `pool-manager.js`, `pool.js`, `pool-lock.js` with claude-pool socket client
- `main.js` connects to claude-pool socket(s) on startup (discovers via `claude-pool pools`)
- Pool settings UI talks to `claude-pool config/init/destroy/resize`
- Session sidebar gets session list from `claude-pool ls` (per pool)
- Status updates via `claude-pool subscribe` (replaces idle-signal polling)
- TUI attach uses `claude-pool attach` (replaces OC daemon attach)
- Offload/archive/resume use claude-pool commands
- Hooks: remove `idle-signal.sh` for pool sessions
- `cockpit-cli` pool commands proxy to claude-pool

### Phase 2: claude-term as terminal backend
- Replace `pty-daemon.js` with claude-term socket client
- Shell tabs spawn via `claude-term spawn` (owner = session ID)
- Shell tab attach via `claude-term attach`
- Terminal tab listing via `claude-term list --owner <session-id>`
- `cockpit-cli term` commands proxy to claude-term
- Remove OC daemon startup/lifecycle code

### Phase 3: Multi-pool UI
- Sidebar groups sessions by pool
- Pool picker for Cmd+Shift+N
- Per-pool settings panels
- Pool creation dialog (name, size, flags, keepFresh)
- Pool color coding in sidebar

### Phase 4: Cleanup
- Remove deleted modules and data directory entries
- Update dev-instance logic (shared vs isolated pools)
- Update all docs
- Remove stale hooks
- Test full workflow end-to-end

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Two external daemons must be running | OC auto-starts them if not running (like it auto-starts its PTY daemon today) |
| Socket connection failures | Reconnect logic with backoff. Show connection status in UI. |
| Version mismatches | OC checks claude-pool/claude-term version on connect. Warn if incompatible. |
| External session discovery regression | Keep existing hooks and discovery logic for non-pool sessions. Test explicitly. |
| TUI rendering differences | The raw PTY pipe is the same data — xterm.js rendering is unchanged |
| Performance (two socket hops) | claude-pool attach is a direct pipe socket (not proxied). Subscribe is push-based. Should be equivalent or faster than polling. |
