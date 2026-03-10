# Dev Workflow Refactor

## Problems

1. **Can't test code changes without disrupting active sessions** — Daemon restart kills PTYs. Main process restart is disruptive.
2. **Multiple dev instances race on shared state** — `pool.json`, `session-graph.json`, idle signals, etc. all shared.
3. **No auto-reload on code changes** — Manual build → kill → relaunch cycle.
4. **Dev instances disrupt the user** — Pop up windows, steal focus.
5. **No headless testing** — Agents can't spin up dev instances programmatically.
6. **No programmatic UI testing** — Can't inspect or drive a dev instance's UI via API.
7. **No isolated e2e testing** — Tests share state with production, making them flaky and dangerous.
8. **Dev instances start empty** — No way to seed realistic session state for bug reproduction.

## Analysis

The daemon is already thin (~460 lines, pure PTY I/O). Architecture is sound — the issues are tooling and isolation gaps.

**Key insight:** If every dev instance has its own `OPEN_COCKPIT_DIR`, ALL files scope automatically — zero shared state, zero race conditions by construction.

---

## Core Mechanism: `OPEN_COCKPIT_DIR`

One env var does everything:

| Role | How |
|------|-----|
| **File scoping** | All paths derive from it. Hooks, pool, daemon, API — everything writes there. |
| **Process identity** | Passed to Claude processes. `ps eww` shows it. Session discovery filters by it. |
| **CLI routing** | `--instance <name>` resolves to `OPEN_COCKPIT_DIR=~/.open-cockpit-dev/<name>/api.sock`. |

No separate `OPEN_COCKPIT_INSTANCE` variable needed.

**Base instance:** `OPEN_COCKPIT_DIR` not set → defaults to `~/.open-cockpit/`. Claude processes have no `OPEN_COCKPIT_DIR` in env → hooks default to `~/.open-cockpit/`.

**Dev instance:** `OPEN_COCKPIT_DIR=~/.open-cockpit-dev/feature-x/` → everything scopes there.

**Filter logic in `discoverSessions()`:** Show a session if its `OPEN_COCKPIT_DIR` (from `ps eww`) matches ours (including both unset for base).

---

## Instance Model

| Instance | `OPEN_COCKPIT_DIR` | State dir | Role |
|----------|-------------------|-----------|------|
| **Base** | _(not set)_ | `~/.open-cockpit/` | Persistent main instance. Reflects repo checkout. Default CLI target. |
| **Dev** | `~/.open-cockpit-dev/<name>/` | same | Temporary, branch-specific. Fully isolated. |
| **Production** | — | Installed app bundle | Unchanged. Separate flow entirely. |
| **Test** | `~/.open-cockpit-test/<name>/` | same | Ephemeral e2e test environment. Predictable path, no temp dir issues. |

---

## File Isolation: Everything-Local

When `OPEN_COCKPIT_DIR` is set, ALL files go there:
- `session-pids/`, `idle-signals/`, `intentions/`
- `pool.json`, `pool-settings.json`, `active-sessions.json`
- `session-graph.json`, `offloaded/`
- `api.sock`, `pty-daemon.sock`, `pty-daemon.pid`
- `debug.log`

When unset, defaults to `~/.open-cockpit/` as today.

**Consequences:**
- Dev instances don't see external sessions → intentional isolation.
- Zero cross-instance file access → zero race conditions by construction.
- Hooks: `OC_DIR="${OPEN_COCKPIT_DIR:-$HOME/.open-cockpit}"` — done.

---

## CLI Resolution

`cockpit-cli` resolves which API socket to connect to:

1. **`--instance <name>` flag** → `~/.open-cockpit-dev/<name>/api.sock` (highest priority)
2. **`OPEN_COCKPIT_DIR` env var** → `$OPEN_COCKPIT_DIR/api.sock` (automatic for sessions inside a dev pool)
3. **Neither set** → `~/.open-cockpit/api.sock` (base instance)

```bash
# From your terminal (targets base instance)
cockpit-cli pool status

# From inside a dev pool session (auto-resolves via inherited env var)
cockpit-cli pool status  # → talks to feature-x API automatically

# Base session controlling a dev instance
cockpit-cli --instance feature-x pool status
cockpit-cli --instance feature-x screenshot
```

---

## Phase 1: Instance Isolation ✅ DONE

**Goal:** Each dev instance is 100% independent via `OPEN_COCKPIT_DIR`.

```bash
npm run dev                                    # → --instance dev
npm run build && electron . --instance my-name # → custom name
```

What was done:
- `paths.js`: ALL paths derive from `OPEN_COCKPIT_DIR` (no branching, no IS_DEV/OWN_POOL)
- `main.js`: `--instance <name>` bootstrap sets `OPEN_COCKPIT_DIR=~/.open-cockpit-dev/<name>/`
- Base instance: no flag → defaults to `~/.open-cockpit/`
- Pool manager: passes `OPEN_COCKPIT_DIR` to spawned Claude processes
- Daemon client: passes `OPEN_COCKPIT_DIR` to daemon spawn env
- `hooks/common.sh`: `OC_DIR="${OPEN_COCKPIT_DIR:-$HOME/.open-cockpit}"`
- `cockpit-cli`: resolves socket via `--instance` flag → `OPEN_COCKPIT_DIR` env → default
- `auto-updater.js`: skips updates for named instances
- Removed: `IS_DEV`, `OWN_POOL`, `--dev`, `--own-pool`, `api-dev.sock`, `pty-daemon-dev.*`, `dev:own-pool` script
- Fixed: auto-release CI (ruleset bypass for bot), failure notification (creates GitHub issue)
- Tested: dev instance runs fully isolated (own daemon, pool, sockets, sessions)

## Phase 2: Auto-watch + Auto-relaunch

**Goal:** Code changes apply automatically. Branch checkout → live update.

```bash
npm run dev:watch -- --instance feature-x
```

### Main process + renderer (auto)

1. Wrapper script starts Electron + `chokidar` watches `src/`
2. On file change: `npm run build`, then sends SIGUSR2 to Electron
3. Main process catches SIGUSR2: saves UI state, `app.relaunch()` + `app.exit()`
4. New process reconnects to daemon → sessions survive
5. App updates within 2-3 seconds

**Branch switching:**
```bash
git checkout feature-branch
# → watcher detects changes → auto-build → auto-relaunch → sessions alive
```

### Daemon code changes (manual notification)

Daemon restart kills all PTYs — can't auto-restart safely. Instead:
- On app launch/relaunch, compare daemon source mtime with running daemon's start time
- If daemon code is stale, show in-app notification: "Daemon code updated. Restart to apply?"
- User clicks "Restart daemon" button when convenient (kills all terminals)
- Daemon files to watch: `pty-daemon.js`, `platform.js`, `secure-fs.js`

## Phase 3: Hidden Dev Mode

**Goal:** Agents can spawn instances that don't disrupt the user.

```bash
npm run dev:hidden -- --instance agent-test-1
```

Implementation: `show: false` on BrowserWindow when `--hidden` flag is set. App runs identically, just invisible. Agents interact via API socket.

**Show/hide at runtime:**
```bash
cockpit-cli --instance agent-test-1 show   # window appears for manual inspection
cockpit-cli --instance agent-test-1 hide   # back to invisible
```

Implementation: API handlers call `BrowserWindow.show()` / `BrowserWindow.hide()`.

## Phase 4: Base Instance Auto-Update (Git-based)

**Goal:** Base instance always reflects whatever's checked out in `~/projects/open-cockpit/`.

Uses Phase 2's auto-watch mechanism on the repo root. `post-merge` hook (already exists) triggers rebuild. Base instance auto-relaunches on build output changes.

## Phase 5: Dev Instance Remote Control

**Goal:** Sessions in the base instance can fully inspect and drive their dev instance via the CLI/API.

Uses `--instance` flag on `cockpit-cli` to target any instance's API socket.

**Already works** (via existing API + `--instance` routing):
- `pool status`, `pool init`, `pool destroy` — manage dev pool
- `ls`, `screen`, `watch` — observe sessions
- `prompt`, `type`, `key`, `start`, `followup` — interact with sessions
- `term read`, `term write`, `term run` — terminal access

**New API endpoints:**
- `screenshot` — `webContents.capturePage()` → returns base64 PNG
- `ui state` — returns structured data: sidebar session list, active session, layout, statuses
- `session select <id>` — switch active session in the UI

## Phase 6: State Seeding (deferred)

Deferred until Phases 1-5 are working. Concept: snapshot export/import for realistic dev instance data. See git history for full design.

## Phase 7: Isolated E2E Testing

**Goal:** Fully isolated test environments that can't corrupt real state.

```bash
OPEN_COCKPIT_DIR=~/.open-cockpit-test/e2e-run-1 npm test
```

- Tests use `~/.open-cockpit-test/<name>/` (not system temp dirs — avoids path issues with Claude CLI)
- Full app lifecycle tests: pool init → session spawn → offload → archive → resume
- Cleanup: `rm -rf ~/.open-cockpit-test/<name>/`
- CI-safe: no dependency on `~/.open-cockpit/`
- Can test multi-instance scenarios by spawning multiple test dirs
- Fixture-based: copy a fixture dir to get known starting state

---

## What We Don't Need

- ❌ Virtual machines — `OPEN_COCKPIT_DIR` isolation is sufficient
- ❌ Daemon hot-reload — daemon is thin, manual restart with in-app notification instead
- ❌ Worker threads — `app.relaunch()` is simpler for same result
- ❌ Separate app bundles — `--instance` handles isolation
- ❌ `OPEN_COCKPIT_INSTANCE` env var — `OPEN_COCKPIT_DIR` serves as both file scope and process identity
- ❌ System temp dirs for tests — `~/.open-cockpit-test/` avoids path issues

---

## Implementation Order

1. **Phase 1** (instance isolation) — Highest impact, unblocks everything
2. **Phase 2** (auto-watch) — Enables branch-switching workflow
3. **Phase 3** (hidden mode) — Enables agent-driven testing
4. **Phase 4** (auto-update) — Depends on Phase 2
5. **Phase 5** (remote control) — Depends on Phase 1
6. **Phase 6** (state seeding) — Depends on Phase 1
7. **Phase 7** (e2e testing) — Depends on Phase 1

Phases 1, 2, 3 are independent. Use cockpit-agents to build in parallel.

---

## Migration

- `npm run dev` → maps to `--instance dev`
- `npm run dev:own-pool` → maps to `--instance dev-pool`
- `OPEN_COCKPIT_TEST_DIR` → renamed to `OPEN_COCKPIT_DIR` (backwards compat alias kept)
- New: `npm run dev:watch`, `npm run dev:hidden`
- `~/.open-cockpit/` (base instance) unchanged
- Production app unchanged
