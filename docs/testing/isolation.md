# Test Isolation

## Problem

Open Cockpit stores all state in `~/.open-cockpit/`. Every module imports path constants from `src/paths.js`. Running tests that create sessions, write pool files, or spawn daemons would interfere with the live app.

## Solution: `OPEN_COCKPIT_TEST_DIR`

`src/paths.js` reads:
```js
const OPEN_COCKPIT_DIR = process.env.OPEN_COCKPIT_TEST_DIR
  || path.join(os.homedir(), ".open-cockpit");
```

All derived paths (`SESSION_PIDS_DIR`, `IDLE_SIGNALS_DIR`, etc.) automatically point to the test directory.

## Test Harness: `test/helpers/test-env.js`

### `createTestEnv()`

Creates a temp directory with the required structure:
```
/tmp/open-cockpit-test-<pid>/
├── session-pids/
├── idle-signals/
├── intentions/
├── offloaded/
└── (other files created by tests as needed)
```

Returns an object with:
- `dir` — the temp directory path
- `cleanup()` — removes temp dir, restores env
- `requireFresh(modulePath)` — clears module cache and re-imports (so paths.js picks up the env var)

### Why `requireFresh`?

Node caches `require()` results. If `paths.js` was already loaded (e.g., by a previous test), changing the env var has no effect. `requireFresh` deletes the cached module and all its dependents, forcing a fresh import.

### Claude Code Tests

For E2E tests that spawn real Claude Code:
- The test writes PID files manually (simulating what `hooks/SessionStart` does)
- The test writes idle signals manually (simulating what `hooks/PreToolUse` does)
- This is necessary because the Open Cockpit plugin hooks hardcode `~/.open-cockpit/` in shell scripts
- The Claude Code process itself is real — only the discovery metadata is managed by the test

## Backend Isolation

Tests that need terminal or pool backends mock the claude-term/claude-pool socket clients. No local daemon processes are spawned by the test harness.
