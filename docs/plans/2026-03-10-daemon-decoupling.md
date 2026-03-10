# Daemon Decoupling for Dev Instances

## Problem

The PTY daemon is shared between dev and production instances. `pty-daemon.js` hardcodes `pty-daemon.sock` and `pty-daemon.pid` — no `--own-pool` awareness. When `dev:own-pool` isolates pool files, terminals still route through the shared daemon. Killing the daemon during dev testing kills all production terminals too.

## Design

Gate daemon isolation on `OWN_POOL` (not `IS_DEV`):
- `npm run dev` (just `--dev`): shares production daemon — correct, since it shares the pool
- `npm run dev:own-pool`: separate daemon — fully isolated

### Changes

1. **`paths.js`**: Branch `DAEMON_SOCKET` and `DAEMON_PID_FILE` on `OWN_POOL`
   - `pty-daemon-dev.sock` / `pty-daemon-dev.pid` when `OWN_POOL`

2. **`daemon-client.js`**: Pass socket/PID paths to daemon via env vars
   - `OPEN_COCKPIT_DAEMON_SOCKET` and `OPEN_COCKPIT_DAEMON_PID`

3. **`pty-daemon.js`**: Read socket/PID paths from env vars, fall back to defaults

4. **Integration tests**: Test crash→restore cycle with mocked daemon (real daemon requires Electron ABI)

## Why `OWN_POOL` not `IS_DEV`

- `--dev` alone reuses the production pool — sharing the daemon is desired
- `--own-pool` means full isolation — pool, terminals, daemon all separate
- This matches the existing isolation pattern for pool files
