# Test Plan: Comprehensive Coverage

## Design Principles

1. **No mocking** — real filesystem, real processes, real Claude Code
2. **Full isolation** — tests never touch `~/.open-cockpit/` or affect the running app
3. **Budget: ~8 Claude Code API calls** — each one tests multiple lifecycle transitions
4. **Representative** — test the same code paths the real app uses

## Isolation Strategy

### The Problem
`paths.js` hardcodes `~/.open-cockpit/`. Every module imports from it. The running app reads the same dirs. Tests must not create files there.

### The Solution: `OPEN_COCKPIT_TEST_DIR` env var

**One-line change to `paths.js`:**
```js
const OPEN_COCKPIT_DIR = process.env.OPEN_COCKPIT_TEST_DIR || path.join(os.homedir(), ".open-cockpit");
```

**Same for `pty-daemon.js`** (it has its own hardcoded path).

Each test file:
1. Creates a temp dir (`/tmp/open-cockpit-test-XXXX/`)
2. Sets `OPEN_COCKPIT_TEST_DIR` before importing modules (vitest `beforeAll`)
3. Creates required subdirs (`session-pids/`, `idle-signals/`, `intentions/`, `offloaded/`)
4. Tears down temp dir in `afterAll`

This is environment setup, not mocking — the real code runs against a real filesystem.

### Test Helper: `test/helpers/test-env.js`

Shared setup:
- Creates temp dir with all subdirs
- Sets env var
- Provides `requireFresh(modulePath)` — clears Node module cache and re-imports (so paths.js picks up the new env var)
- Provides `cleanup()` — removes temp dir, restores env
- For Claude Code tests: spawns real `claude` process with `--session-id`

---

## Tier 1: Pure Unit Tests (no Claude Code, no daemon)

### 1.1 `secure-fs.test.js` — NEW
Functions are parameterized (take explicit paths). Test with temp dir.

| Test | What it verifies |
|------|-----------------|
| `secureMkdirSync` creates dir with mode 0o700 | Permission enforcement |
| `secureWriteFileSync` writes file with mode 0o600 | Permission enforcement |
| `readJsonSync` returns parsed JSON | Happy path |
| `readJsonSync` returns fallback on ENOENT | Missing file |
| `readJsonSync` returns fallback on invalid JSON | Corrupt file |
| Options passthrough (encoding, etc.) | Merged opts |

### 1.2 `session-stats.test.js` — NEW
`parseJsonlStats` takes a file path. Create fixture JSONL files in temp dir.

| Test | What it verifies |
|------|-----------------|
| Parses tokens from assistant messages | input/output/cache token extraction |
| Computes correct cost estimate | Pricing math for each model tier |
| Counts turns, assistant messages, tool uses | Counter accuracy |
| Determines primary model from mixed usage | Most-frequent model wins |
| Computes duration from first/last timestamp | Timestamp math |
| Handles empty/corrupt JSONL gracefully | No crash on bad input |
| `findChildSessionIds` + `findAllDescendants` | Graph traversal (pure functions, no I/O) |
| `getPricing` partial model name matching | `claude-sonnet-4-6-20250514` → sonnet pricing |

### 1.3 `platform.test.js` — NEW
Test the portable helpers (not macOS-specific subprocess calls).

| Test | What it verifies |
|------|-----------------|
| `resolveClaudePath` finds claude binary | Binary exists on PATH |
| Shell detection returns valid shell | At least one allowed shell |
| `isRootPath` detects `/` and drive roots | Edge case paths |
| `chmodSync` works on macOS, no-ops concept on Windows | Platform guard |

### 1.4 `session-discovery-helpers.test.js` — NEW
Test individual exported helpers that accept parameters.

| Test | What it verifies |
|------|-----------------|
| `findGitRoot` from a git repo subdir | Walks up to `.git` |
| `findGitRoot` returns null outside git | No `.git` found |
| `getIntentionHeading` extracts `# Heading` | Regex parsing |
| `getIntentionHeading` returns null for no heading | Missing `#` |
| `getIdleSignal` reads valid JSON signal | File parsing |
| `getIdleSignal` returns null on ENOENT | Missing file |
| `transcriptContains` finds needle in chunks | 64KB chunked reading |
| `transcriptContains` finds needle spanning chunk boundary | Overlap logic |
| `transcriptContains` returns false for missing needle | No false positives |
| `freshOrTyping` logic | Status decision tree |

---

## Tier 2: Integration Tests (real fs, isolated dir, no Claude Code)

These use `OPEN_COCKPIT_TEST_DIR` to point all modules at a temp dir. Real filesystem operations, real module code, no mocks.

### 2.1 `session-discovery-integration.test.js` — NEW
Set up real files in the test dir, run `getSessions()`.

| Test | What it verifies |
|------|-----------------|
| PID file for alive process → session discovered | Basic discovery |
| PID file for dead PID → auto-archived (with intention) | Dead session archival |
| PID file for dead PID without intention → cleaned up | Empty session pruning |
| Idle signal present → status is `idle` | Idle detection |
| No idle signal + transcript growing → `processing` | Processing detection |
| Offloaded session dir → appears as `offloaded` | Offload discovery |
| Archived flag in meta.json → `archived` | Archive detection |
| Duplicate PIDs for same session → deduplication | Winner selection |
| Fingerprint cache → fast path when nothing changed | Performance |
| `invalidateSessionsCache` forces refresh | Cache invalidation |

Implementation: Create real PID files pointing to `$$` (test process PID) for "alive" sessions, and a known-dead PID for dead ones. Write real idle signal JSON files. Create real offload dirs with meta.json.

### 2.2 `daemon-client.test.js` — NEW
Start a real PTY daemon in the test dir, communicate over its socket.

| Test | What it verifies |
|------|-----------------|
| `startDaemon` + `connectToDaemon` → connected | Daemon lifecycle |
| `daemonRequest` spawn + list → terminal created | PTY creation |
| `daemonRequest` write → data in buffer | Terminal I/O |
| `daemonRequest` resize → acknowledged | Terminal resize |
| `daemonRequest` kill → terminal removed | Terminal cleanup |
| Daemon auto-starts on first request | Lazy startup |
| Timeout on unresponsive request | Error handling |
| Socket reconnect after daemon restart | Recovery |

⚠️ Requires `node-pty` compiled for Node (not Electron). May need `ELECTRON_RUN_AS_NODE=1` or a vitest-compatible daemon startup.

### 2.3 `pool-lifecycle.test.js` — NEW
Test pool read/write/sync in the isolated dir.

| Test | What it verifies |
|------|-----------------|
| `writePool` + `readPool` roundtrip | Atomic write/read |
| `syncStatuses` marks dead slots | Status sync with real PIDs |
| `computePoolHealth` with mixed slot states | Health calculation |
| Pool lock serializes concurrent writes | No data races |

---

## Tier 3: E2E with Claude Code (~8 API calls)

These spawn real Claude Code sessions and observe state transitions through the Open Cockpit API/discovery. Each test is designed to maximize coverage per API call.

### Isolation for Claude Code tests

1. Test uses `OPEN_COCKPIT_TEST_DIR` temp dir
2. Starts its own daemon + API server in that dir
3. Spawns Claude Code with:
   - `--session-id <test-uuid>` — deterministic ID
   - Working dir: the temp dir (so JSONL goes to a test-specific `.claude/projects/` path)
4. Manually writes PID file (simulating what the SessionStart hook does)
5. Observes via `getSessions()` from session-discovery (pointed at test dir)

**Why manual PID files**: The Open Cockpit plugin hooks write to `~/.open-cockpit/` (hardcoded in shell scripts). Modifying hooks for tests is fragile. Instead, we replicate the essential hook behavior (PID file + idle signal) in the test harness. The actual Claude Code process is real — we just manage the discovery metadata ourselves.

### 3.1 `e2e-session-lifecycle.test.js` — ~4 Claude Code calls

**Test A: Spawn → Processing → Idle** (1 API call)
1. Spawn `claude --session-id <id> -p "Say exactly: hello" --output-format text`
2. Write PID file in test dir
3. Poll `getSessions()` — verify session appears with `status: processing`
4. Wait for Claude to finish (process exits or idle signal)
5. Write idle signal in test dir
6. Verify `status: idle`

**Test B: Offload → Restore** (1 API call)
1. From Test A's idle session, call offload logic (snapshot terminal, write meta, clear)
2. Verify `getSessions()` shows `status: offloaded`
3. Call restore logic (spawn new Claude Code with `--resume`)
4. Write new PID file
5. Verify session is back as `idle` or `processing`

**Test C: Archive → Unarchive** (0 API calls — uses offloaded state)
1. Set `archived: true` in meta.json
2. Verify `getSessions()` shows `status: archived`
3. Remove `archived` flag
4. Verify back to `offloaded`

**Test D: Fresh → Typing → Clear** (1 API call)
1. Spawn Claude Code with `--session-id` (pool-style, no initial prompt)
2. Write intention file content
3. Verify `status: typing` (has intention content)
4. Kill the process
5. Verify cleanup

### 3.2 `e2e-session-stats.test.js` — ~2 Claude Code calls

**Test E: Single session stats** (1 API call)
1. Spawn Claude Code: `claude -p "What is 2+2?" --session-id <id>`
2. Wait for completion
3. Call `getSessionStats(id)` (from session-stats.js)
4. Verify: turns > 0, tokens.input > 0, tokens.output > 0, cost > 0, model starts with "claude"

**Test F: Sub-agent stats aggregation** (1 API call)
1. Spawn Claude Code: `claude -p "Use the Agent tool to ask: what is 1+1?" --session-id <id>`
2. Wait for completion
3. Write session-graph.json with parent→child relationship
4. Call `getSessionStats(id)` with graph
5. Verify `subAgents` array populated, `totalWithSubAgents` > main session alone

### 3.3 `e2e-api.test.js` — ~2 Claude Code calls

**Test G: API get-sessions with live session** (1 API call)
1. Start API server in test dir with real handlers
2. Spawn Claude Code session
3. Send `{"type": "get-sessions"}` to API socket
4. Verify response contains the test session with correct fields

**Test H: API pin/unpin** (0 extra API calls — reuses G's session)
1. Send `{"type": "pin-session", "sessionId": "<id>"}`
2. Verify session is pinned
3. Send `{"type": "unpin-session", "sessionId": "<id>"}`
4. Verify unpinned

---

## Implementation Order

1. **`test/helpers/test-env.js`** — shared isolation harness
2. **`paths.js` + `pty-daemon.js`** — add `OPEN_COCKPIT_TEST_DIR` env var support
3. **Tier 1 tests** (4 files, parallel sub-agents)
4. **Tier 2 tests** (3 files, parallel sub-agents)
5. **Tier 3 tests** (3 files, sequential — each needs Claude Code)

## Claude Code Call Budget

| Test | Calls | What it proves |
|------|-------|---------------|
| A: Spawn→Process→Idle | 1 | Core lifecycle |
| B: Offload→Restore | 1 | Session persistence |
| D: Fresh→Typing→Clear | 1 | Pool slot recycling |
| E: Single stats | 1 | Stats accuracy |
| F: Sub-agent stats | 1 | Graph + aggregation |
| G: API with live session | 1 | API integration |
| **Total** | **6** | |

Tests C and H use pre-existing state, no Claude Code calls.

## Risk: Daemon in Tests

The PTY daemon requires `node-pty` compiled for the right Node ABI. In vitest (plain Node), this should work if `npm install` was run (it compiles for system Node). If it fails, Tier 2 daemon tests can be skipped with a clear error message, and Tier 3 tests can use `child_process.spawn` directly instead of the daemon.

## Files Created/Modified

**Modified:**
- `src/paths.js` — 1 line: env var override for `OPEN_COCKPIT_DIR`
- `src/pty-daemon.js` — 1 line: same env var override

**Created:**
- `test/helpers/test-env.js` — shared test harness
- `test/secure-fs.test.js`
- `test/session-stats.test.js`
- `test/platform.test.js`
- `test/session-discovery-helpers.test.js`
- `test/session-discovery-integration.test.js`
- `test/daemon-client.test.js`
- `test/pool-lifecycle.test.js`
- `test/e2e-session-lifecycle.test.js`
- `test/e2e-session-stats.test.js`
- `test/e2e-api.test.js`
- `test/fixtures/` — JSONL fixtures for stats tests
