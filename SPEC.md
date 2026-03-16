# Spec

> ⛔ **Protected.** Do not edit without explicit user permission.

## Dependencies

- **claude-pool** — Pool management, session lifecycle, Claude TUI PTY ownership. OC connects to pool daemons via Unix socket API.
- **claude-term** — Persistent terminal management for shell tabs. OC connects to the claude-term daemon via Unix socket API.

OC does not manage Claude processes, PTYs, or pool state. It is a frontend.

---

## What OC owns

- **Intention files** — Markdown files (`~/.open-cockpit/intentions/<claude-uuid>.md`) that describe what a session is working on. Keyed by Claude UUID (works for both pool and external sessions).
- **Hooks** — Intention introduction (first prompt) and intention change notification (diff on edit). Installed as a Claude Code plugin.
- **External session discovery** — Detects Claude Code sessions started outside any pool. Uses PID mapping (`~/.open-cockpit/session-pids/<PID>`) written by a SessionStart hook.
- **Custom agents** — Named shell scripts (`~/.open-cockpit/agents/`) that compose CLI commands into workflows.
- **UI** — Electron app: session sidebar, intention editor, terminal tabs, dock layout, command palette, keyboard shortcuts, pool management panels.
- **cockpit-cli** — CLI for OC-specific operations only (see below). Not a proxy for claude-pool or claude-term.
- **Window management** — Show, hide, screenshot, dev instances.

---

## Session model

OC presents a unified view of all Claude sessions on the machine:

| Source | How OC discovers them |
|--------|----------------------|
| **Pool sessions** | `claude-pool ls` per running pool + `subscribe` for live updates |
| **External sessions** | PID mapping hook + process scanning (existing discovery logic) |

### Display states

OC derives display states from claude-pool's session status and metadata:

| Display state | Derived from |
|---------------|-------------|
| Fresh | `status=idle` + never prompted (no turns in transcript) |
| Typing | `status=idle` + `pendingInput != ""` |
| Idle | `status=idle` + `pendingInput == ""` + has been prompted |
| Processing | `status=processing` |
| Queued | `status=queued` |
| Offloaded | `status=offloaded` |
| Archived | `status=archived` |
| Error | `status=error` |
| External | Discovered via PID scanning, not managed by any pool |

### Origin tags

Sessions are tagged by source:

| Tag | Meaning |
|-----|---------|
| Pool name (e.g., `default`, `research`) | Session belongs to that pool |
| `external` | Session started outside any pool |

Sub-claude / child relationships are derived from claude-pool's `parent` field, not a separate origin tag.

---

## Multi-pool

OC discovers all running pools via `claude-pool pools` and connects to each. The sidebar groups sessions by pool.

- **Cmd+N** — Start a promptless session in the active pool (claims a fresh slot for TUI interaction via `attach`).
- **Cmd+Shift+N** — Pool picker: select an existing pool or create a new one (name, size, flags, keepFresh). Starts a promptless session in the chosen pool.
- **Pool settings** — Per-pool: init, destroy, resize, config, health. Accessible from sidebar or command palette.

---

## Terminal tabs

Each session can have multiple terminal tabs displayed in the dock:

| Tab type | Backed by | Notes |
|----------|-----------|-------|
| Claude TUI | `claude-pool attach` + `pty-resize` | Raw PTY pipe. Only available for live sessions (idle, processing). |
| Shell | `claude-term` | Shell process with `owner` set to the session's Claude UUID. |

---

## Intention files

- Stored at `~/.open-cockpit/intentions/<claude-uuid>.md`.
- Keyed by **Claude UUID** — the universal identifier that works for both pool and external sessions.
- The **intention introduction hook** (UserPromptSubmit, once per session) tells Claude about the file on first prompt.
- The **intention change hook** (UserPromptSubmit) diffs the file against a snapshot and surfaces changes to Claude.

---

## Hooks

OC installs a Claude Code plugin with these hooks:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `session-pid-map.sh` | SessionStart | PID→Claude UUID mapping for intention hooks and external session discovery. Fires for all sessions. |
| `session-intention-intro.sh` | UserPromptSubmit (once) | Introduce the intention file to Claude on first prompt |
| `intention-change-notify.sh` | UserPromptSubmit | Surface intention file edits (diff) to Claude |

These coexist with claude-pool's hooks and claude-term's hooks. Each system installs independently.

Idle detection hooks are **not needed** — claude-pool handles idle detection internally and exposes status via `subscribe`.

---

## cockpit-cli

OC-specific CLI. Talks to OC's API socket (`~/.open-cockpit/api.sock`). Does **not** proxy claude-pool or claude-term commands — those CLIs are standalone.

### Session view
| Command | Description |
|---------|-------------|
| `ls` | Merged session list (all pools + external). Shows what the sidebar shows. |
| `intention <uuid>` | Read intention file |
| `intention <uuid> <text>` | Write intention file |

### Agents
| Command | Description |
|---------|-------------|
| `agents` | List available agents |
| `agent <name> [args]` | Run a named agent |

### Window
| Command | Description |
|---------|-------------|
| `show` / `hide` | Window visibility |
| `screenshot` | Capture window (base64 PNG or `--raw` for file) |
| `ui-state` | Active session, session list as the UI sees it |
| `session-select <id>` | Switch the active session in the UI |

### Dev instances
| Command | Description |
|---------|-------------|
| `dev launch` | Start a dev instance (`--hidden`, `--watch`) |
| `dev status` / `dev kill` | Manage dev instance |

All commands accept `--dev` (target this session's dev instance) or `--instance <name>`.

---

## Dev instances

Dev instances are isolated OC frontends for testing. They share the same claude-pool and claude-term daemons as the base instance (no duplication of pool/terminal state).

- Dev instances connect to all running pools (same as base instance).
- Dev instances can create their own test pool (`claude-pool init --pool dev-<id>`).
- No race conditions — claude-pool handles concurrent clients on the same socket.
- `OPEN_COCKPIT_DIR` scopes OC-specific state (intentions, agents, shortcuts, API socket). Pools and terminals are external.
- Parent-PID watchdog auto-cleans dev instance when the owning Claude session exits.

---

## Data directory

`~/.open-cockpit/` (override: `OPEN_COCKPIT_DIR`)

| Path | Purpose |
|------|---------|
| `intentions/<claude-uuid>.md` | Intention files |
| `session-pids/<PID>` | PID→UUID mapping (external session discovery) |
| `agents/` | Global agent scripts |
| `shortcuts.json` | Keyboard shortcut overrides |
| `colors.json` | Directory color overrides |
| `debug.log` | OC debug log |
| `api.sock` | OC API socket |

Files **removed** compared to current OC (now owned by claude-pool or claude-term):
`pool.json`, `pool-settings.json`, `pool-spawned-pids/`, `idle-signals/`, `session-graph.json`, `offloaded/`, `active-sessions.json`, `pty-daemon.sock`, `pty-daemon.pid`.
