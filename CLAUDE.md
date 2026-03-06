# Open Cockpit

Electron app + Claude Code plugin for session intention tracking.

## Architecture

- `src/pty-daemon.js` — **PTY daemon**: standalone process managing all terminals ([docs/pty-daemon.md](docs/pty-daemon.md))
- `src/api-server.js` — **API server**: Unix socket API for external process control ([docs/api.md](docs/api.md))
- `src/main.js` — Main process: window, IPC, daemon client, session discovery
- `src/preload.js` — Context bridge (`api` object)
- `src/shortcuts.js` — Configurable keyboard shortcuts (defaults, overrides, accelerator matching)
- `src/pool.js` — Pure pool data structures (readPool, writePool, computePoolHealth)
- `src/sort-sessions.js` — Session display ordering (used by main.js)
- `src/renderer.js` — CodeMirror 6 live preview editor + session sidebar
- `src/index.html` + `src/styles.css` — Layout, neon red dark theme
- `bin/cockpit-cli` — CLI for observing and interacting with agents. High-level commands (`ls`, `screen`, `watch`, `log`, `prompt`, `key`, `type`) + session commands (`start`, `followup`, `wait`, `pin`, `stop`) + pool management ([docs/api.md](docs/api.md))
- `skills/cockpit-sessions/` — Skill docs for Claude Code (SKILL.md + sub-skills)
- `hooks/` — Claude Code plugin hooks (PID mapping, intention intro, idle/fresh signal detection, intention change notify)
- `.claude-plugin/plugin.json` — Plugin manifest
- `.github/workflows/auto-release.yml` — CI auto-bumps version + updates marketplace on push
- `release.sh` — Manual fallback for version bump + marketplace deployment

## Pool management

The app can manage a pool of pre-started Claude sessions. Pool state lives in `~/.open-cockpit/pool.json`.

- **Init**: via UI or API (`pool-init` with size). Spawns Claude sessions via the PTY daemon using `resolveClaudePath()` (finds `claude` binary via `which` + fallback paths). Trust prompt is accepted via buffer polling (not hardcoded delay).
- **Dead/error slots**: `reconcilePool()` auto-restarts dead and error slots. Runs on startup and every 30s. Orphaned processes are killed via `killSlotProcess()` (daemon + PID fallback) before respawn.
- **Offloading**: Idle sessions get offloaded (snapshot + `/clear`). External `/clear` is also detected and saved as offloaded.
- **Archiving**: All dead sessions are auto-archived (`archived: true` in meta.json). Any session can be manually archived via right-click. Pool sessions auto-offload before archiving.
- **Destroy**: `pool-destroy` kills all slots and removes `pool.json`. Uses `killSlotProcess()` (daemon + PID fallback) to prevent orphans.
- **Write locking**: All pool.json read-modify-write cycles use `withPoolLock()` to prevent concurrent write races.
- **Settings UI**: Auto-refreshes every 3s. Clicking a slot row opens an interactive terminal popup attached to the live PTY.

### Plugin update → pool reinit

After pushing to `main`, CI auto-bumps the version and updates the marketplace. Claude Code's auto-update picks up the new version within 1–2 minutes. Pool sessions started before the update have stale hooks. To pick up new hooks:

1. Wait 1–2 minutes after push for CI + auto-update
2. Destroy the pool (`pool-destroy` via API or UI)
3. Re-initialize (`pool-init`)

New sessions will have the latest hooks.

## Key paths

- `~/.open-cockpit/session-pids/<PID>` — Session ID (written by plugin hook)
- `~/.open-cockpit/intentions/<session_id>.md` — Intention files (created lazily: by Claude on first prompt, or by app on first user keystroke)
- `~/.open-cockpit/colors.json` — Directory color overrides ([docs/theme.md](docs/theme.md))
- `~/.open-cockpit/idle-signals/<PID>` — Idle signal files (written by plugin hooks)
- `~/.open-cockpit/pool.json` — Pool state (slots, sizes, session mappings, pinnedUntil)
- `~/.open-cockpit/session-graph.json` — Parent-child session relationships (initiator: "user"|"model")
- `~/.open-cockpit/offloaded/<sessionId>/` — Offloaded/archived session data (meta.json, snapshot.log)
- `~/.open-cockpit/shortcuts.json` — User keyboard shortcut overrides (only non-default values)
- `~/.open-cockpit/setup-scripts/` — Setup script files for Cmd+N picker
- `~/.open-cockpit/debug.log` — Debug log (both main + renderer, rotates at 2 MB)
- `~/.open-cockpit/api.sock` — Programmatic API Unix socket
- `~/.open-cockpit/pty-daemon.sock` — PTY daemon Unix socket
- `~/.open-cockpit/pty-daemon.pid` — PTY daemon PID file

## Dev

```bash
npm run build   # Bundle renderer only (esbuild)
```

> ⚠️ All launch commands include `unset ELECTRON_RUN_AS_NODE` — required when launching from an app-managed terminal, where the env var makes Electron run as plain Node.js.

### Opening the production instance

`npm start` launches the production instance. It exits immediately while Electron runs in the background — **running it twice stacks instances**. Always use this kill-before-launch command:

```bash
cd ~/Documents/Projects/open-cockpit && DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; unset ELECTRON_RUN_AS_NODE && nohup npm start > /dev/null 2>&1 &
```

## Releasing

**Automatic (CI):** Every push to `main` triggers `.github/workflows/auto-release.yml`:
1. Bumps patch version in `.claude-plugin/plugin.json`
2. Commits with `[skip ci]` to prevent loops
3. Clones `EliasSchlie/claude-plugins`, updates marketplace version, pushes

Just push your changes — CI handles version bumping and marketplace sync. For major/minor bumps, manually update `plugin.json` before pushing; CI increments from your number.

**Requires:** `APP_ID` and `APP_PRIVATE_KEY` secrets on the repo (from the "Plugin Release Bot" GitHub App, installed on `open-cockpit` + `claude-plugins`).

**Manual fallback:** `./release.sh` still works for local releases if CI is unavailable.

## Dev vs production

- `npm start` — production instance (user's daily driver, don't touch during dev)
- `npm run dev` — dev instance with separate user data dir + "DEV" in title, safe to restart freely
- `npm run dev:own-pool` — like `dev` but uses its own pool (`pool-dev.json`), isolated from production
- Both can run simultaneously
- Multiple Claude sessions may run dev instances concurrently from different worktrees

> ⚠️ **Pool operations in dev mode**: By default, `npm run dev` shares the production pool. If you need to init, destroy, resize, or otherwise modify the pool during development, **always use `npm run dev:own-pool`** to avoid disrupting the production pool.

## Git hooks

Git hooks live in `.githooks/` (version-controlled). `core.hooksPath` is set automatically via the `prepare` script in `package.json` (runs on `npm install`).

- `pre-commit` — runs prettier
- `post-checkout` — auto-installs deps + builds renderer for new worktrees
- `post-merge` — auto-builds renderer after `git pull` (+ `npm install` if `package-lock.json` changed)

## Worktree setup

Worktrees auto-setup via the `post-checkout` hook — just `git worktree add` and it's ready.

### Merging worktree PRs

`gh pr merge --delete-branch` fails from worktrees. Always merge from the **root worktree** without `--delete-branch`, then clean up:

```bash
cd ~/Documents/Projects/open-cockpit
gh pr merge <number> --squash
git worktree remove .wt/<name>
git branch -d <branch>
git pull
```

## Managing dev instances (multi-session safe)

Multiple Claude sessions may work on different worktrees simultaneously. Electron processes inherit the `cwd` of the worktree — use `lsof` to identify and kill only yours.

> ⚠️ **CRITICAL: You MUST `cd` into your worktree/project directory before running the kill/launch command.** The command uses `$(pwd)` to scope which Electron process to kill. Running it from `~` or any other directory risks killing the **production instance** if it was launched from that directory.

**Always use this command to launch** (kills any existing instance first — safe even on first launch):
```bash
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null; sleep 0.5; unset ELECTRON_RUN_AS_NODE && nohup npm run dev > /dev/null 2>&1 &
```

> ⚠️ `npm run dev` exits immediately while Electron stays running in the background.
> It will *look* like it died — it didn't. Always kill-before-launch to avoid stacking instances.
> The daemon PID is excluded so terminals survive restarts.

**Kill only YOUR worktree's instance:**
```bash
DAEMON_PID=$(cat ~/.open-cockpit/pty-daemon.pid 2>/dev/null || echo NONE); lsof -c Electron 2>/dev/null | awk -v dir="$(pwd)" '/cwd/ && $NF == dir {print $2}' | grep -v "^${DAEMON_PID}$" | sort -u | xargs kill 2>/dev/null
```

**NEVER** use `pkill -f electron`, `killall Electron`, or `grep "cwd.*$(pwd)"` (substring match) — these can kill other sessions' instances or the production app. Always use exact `$NF == dir` matching as shown above.

## Reloading after changes

- **Renderer changes** (`renderer.js`, `styles.css`, `index.html`): `npm run build`, then Cmd+R in the dev window. Terminals survive (daemon keeps them alive).
- **Main process changes** (`main.js`, `preload.js`): kill and restart your dev instance (see commands above). Terminals survive (daemon keeps them alive).
- **Daemon changes** (`pty-daemon.js`): kill daemon (`kill $(cat ~/.open-cockpit/pty-daemon.pid)`), then restart app. This kills all terminals.

> ⚠️ **Avoid restarting the production instance** (`npm start`) unless the user explicitly asks. Restarting disrupts all active sessions. For testing, use `npm run dev` instead. If you must restart production, confirm with the user first.

## Further docs

- [docs/pty-daemon.md](docs/pty-daemon.md) — PTY daemon architecture, protocol, debugging
- [docs/theme.md](docs/theme.md) — Color scheme, directory color coding, user overrides
- [docs/hooks.md](docs/hooks.md) — Plugin hooks
- [docs/api.md](docs/api.md) — Programmatic API (Unix socket, CLI helper)
- [docs/shortcuts.md](docs/shortcuts.md) — Keyboard shortcuts reference + how to add new ones
- [docs/debug-logging.md](docs/debug-logging.md) — Persistent debug logging (`~/.open-cockpit/debug.log`)

## Session graph (parent-child tracking)

Sessions track who started them and parent-child relationships in `~/.open-cockpit/session-graph.json`:
- **initiator**: `"user"` (human via UI/terminal) or `"model"` (Claude via `cockpit-cli start`)
- **parentSessionId**: the session that spawned this one (null for top-level)
- CLI auto-detects parent by walking PPID chain → `~/.open-cockpit/session-pids/`
- API: `pool-start` accepts optional `parentSessionId`; `get-session-graph` returns the full graph
- `get-sessions` response enriched with `parentSessionId` and `initiator` fields

## Session pinning

Pool slots can be pinned to prevent LRU offloading:
- `pool-pin { sessionId, duration }` — pin for N seconds (default 120)
- `pool-unpin { sessionId }` — release pin
- `pinnedUntil` field in pool.json slots; expired pins auto-cleared on eviction check
- CLI: `cockpit-cli pin <id> [seconds]` / `cockpit-cli unpin <id>`

## Session origin tags

Sessions in the sidebar display an origin tag:
- **pool** (green) — spawned by the pool manager (`OPEN_COCKPIT_POOL=1` env var)
- **sub-claude** (purple) — spawned by sub-claude (`SUB_CLAUDE=1` env var)
- **ext** (gray) — external sessions (no known env markers)

Detection uses `ps eww <PID>` to read process environment. Results are cached by PID.

## Setup scripts

When pressing Cmd+N with scripts in `~/.open-cockpit/setup-scripts/`, a picker appears. Selected script content is auto-typed into the fresh Claude TUI. Script format: plain text, `\r` for Enter. If no scripts exist, Cmd+N opens a fresh session directly.

## Terminal tab model

- **Pool sessions** (non-external): The first terminal tab shows the **live Claude TUI** from the pool slot (attached via daemon). Users interact with Claude directly through this tab.
- **External sessions** (started outside the app): First tab is a fresh shell, since the app doesn't own their terminal.
- **Additional tabs** (via "+" in the tab bar): Always fresh shells at the session's cwd.

Tab labeled "Claude" for pool TUI, "Terminal N" for shells. Pool TUI tabs detach on close (don't kill the daemon PTY). Falls back to fresh shell if pool slot not found or attach fails.

### Programmatic terminal access

Sessions can discover and interact with their own terminal tabs via the `session-terminals` API and `cockpit-cli term` commands. All `term` subcommands auto-detect the caller's session ID by walking PID ancestry (checks `~/.open-cockpit/session-pids/<PID>`), so no target is needed when calling from within a Claude session.

**High-level commands (recommended):**
- `cockpit-cli term exec 'npm test'` — one-shot: opens ephemeral shell → runs command → returns output → closes tab
- `cockpit-cli term run 1 'make build'` — runs command in an existing shell tab, returns output when done

**Low-level primitives:**
- `cockpit-cli term ls` — list terminal tabs (index, label, TUI flag)
- `cockpit-cli term read 1` / `term write 1 'text'` / `term key 1 enter` — direct tab I/O
- `cockpit-cli term open` / `term close 1` — manage tabs
- `cockpit-cli term watch 1` — follow output in real-time

Tabs are addressed by index (0 = first tab, typically TUI for pool sessions). See [docs/api.md](docs/api.md) for full reference.

## Session lifecycle

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

### Idle detection invariants

- **Idle signal = idle.** The app trusts the signal file directly — no mtime/size cross-checks against the JSONL transcript.
- **Why:** Local commands (`/model`, `/help`, etc.) write to the JSONL without triggering hooks, which would cause false "processing" if we compared transcript mtime with signal mtime.
- **Safety:** `UserPromptSubmit` always clears the signal before processing begins. Stop-hook re-prompts happen within an already-cleared cycle, so no stale signal persists during processing.
- **No false idle positives.** The app may trigger notifications on idle transitions — a premature "idle" is worse than a delayed one.

### Debugging session state

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

### Archiving

- **Auto-archive**: Dead sessions with an intention heading are auto-archived. Sessions that were never used (no intention, no snapshot) are silently discarded to avoid archive spam.
- **Manual archive**: Right-click any session → "Archive". Pool sessions are auto-offloaded (snapshot + `/clear`) before archiving.
- **Sidebar**: Archive section appears below Processing. Archived sessions are dimmed.
- **Resume**: Click an archived session → "Restart Session" dialog → acquires a fresh pool slot, runs `/resume <uuid>`, moves back to Recent.
- **Unarchive**: Right-click archived session → "Move to Recent" moves it back to offloaded (no restart).
- **Data**: `archived: true` flag in `~/.open-cockpit/offloaded/<id>/meta.json`.

## Conventions

- **Every user-facing action must have a keyboard shortcut.** See [docs/shortcuts.md](docs/shortcuts.md) for the full list and how to add new ones.
- Electron: contextIsolation, sandbox off (preload needs npm packages)
- CodeMirror 6 bundled with esbuild
- Auto-save 500ms debounce, file watching via `fs.watchFile` (polling)
- Plugin version in `.claude-plugin/plugin.json`, marketplace in `EliasSchlie/claude-plugins`
