# Transition Plan: Use claude-pool + claude-term as Backends

## Overview

Replace Open Cockpit's built-in PTY daemon and pool management with
claude-pool (session management) and claude-term (shell terminals) as
external backend services.

## What Changes

### Removed modules
- `src/pty-daemon.js` — replaced by claude-term daemon
- `src/pool.js` — pool state now lives in claude-pool
- `src/pool-lock.js` — locking managed by claude-pool
- `src/active-sessions.js` — crash recovery managed by claude-pool

### New modules
- `src/claude-term-client.js` — Node.js socket client for claude-term
- `src/claude-pool-client.js` — Node.js socket client for claude-pool

### Simplified modules
- `src/pool-manager.js` — delegates to claude-pool, keeps intentions/graph/offload-meta
- `src/session-discovery.js` — uses claude-pool ls for pool sessions
- `src/main.js` — uses new clients, no pty-daemon lifecycle
- `src/api-handlers.js` — routes through new backends
- `src/daemon-client.js` — replaced by new clients

### Mostly unchanged
- All renderer modules (terminal-manager, sidebar, dock, etc.)
- preload.js (same IPC surface, minimal adaption)
- Hooks (still write PID files + idle signals)

## Architecture

```
Renderer (xterm.js) ←IPC→ Main Process ←socket→ claude-term (shell tabs)
                                        ←socket→ claude-pool (pool sessions)
```

Shell tabs (user-spawned terminals):
  OC → claude-term spawn/write/resize/kill/attach/detach

Pool sessions (Claude CLI instances):
  OC → claude-pool init/start/followup/archive/unarchive/health/attach

Session discovery:
  - Pool sessions: claude-pool ls + existing hook-based PID/idle-signal files
  - External sessions: existing PID file scanning (unchanged)

## Key Differences

| Aspect | Old (pty-daemon) | New (claude-term/pool) |
|--------|-------------------|------------------------|
| Shell tabs | pty-daemon spawn | claude-term spawn |
| Pool sessions | pty-daemon spawn + pool-manager | claude-pool managed |
| Term IDs | integer (auto-increment) | string ("t1", "t2") |
| Pool session IDs | UUID from PID file | claude-pool internal ID |
| Data encoding | raw string | base64 (claude-term) / raw bytes (claude-pool attach) |
| Attach (pool) | JSON events on main socket | dedicated raw PTY socket per session |
| Pool state | pool.json (OC-managed) | claude-pool internal (API access) |
| Node-pty | required (native module) | not needed |

## Dependencies Removed
- `node-pty` — no longer needed (claude-term/pool own the PTYs)

## Pool Mapping

| OC operation | claude-pool API |
|--------------|-----------------|
| poolInit(size) | init {size} |
| poolResize(size) | resize {size} |
| poolDestroy() | destroy |
| getPoolHealth() | health |
| poolResume(sessionId) | unarchive {sessionId} |
| offloadSession() | archive {sessionId} |
| start session | start {prompt} |
| send followup | followup {sessionId, prompt} |
| wait for idle | wait {sessionId} |
| get output | capture {sessionId} |

## Terminal Mapping

| OC operation | claude-term API |
|--------------|-----------------|
| spawn shell | spawn {cmd, cwd, owner} |
| write to terminal | write {term_id, data} |
| read buffer | read {term_id} |
| resize | resize {term_id, cols, rows} |
| kill | kill {term_id} |
| list | list {owner} |
| attach | attach {term_id} |
| detach | detach {term_id} |
