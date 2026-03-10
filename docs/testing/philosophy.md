# Testing Philosophy

## Core Principles

1. **No mocking** — real filesystem, real processes, real Claude Code. Tests that mock behavior prove the mock works, not the code.
2. **Full isolation** — tests never touch `~/.open-cockpit/` or affect the running app. A developer running tests while using Open Cockpit should notice nothing.
3. **Representative** — test the same code paths production uses. If the app reads a file from disk, the test reads a file from disk.
4. **Budget Claude Code calls** — real API calls are expensive. Each E2E test should cover multiple lifecycle transitions per call.

## Isolation Strategy

The `OPEN_COCKPIT_TEST_DIR` environment variable redirects all path constants from `~/.open-cockpit/` to a temporary directory. This is a one-line override in `paths.js` — not mocking, just environment configuration.

Each test file:
1. Creates `/tmp/open-cockpit-test-<pid>/` with required subdirs
2. Sets `OPEN_COCKPIT_TEST_DIR` before importing modules
3. Runs real code against real files in the temp dir
4. Tears everything down in `afterAll`

See [`test/helpers/test-env.js`](../../test/helpers/test-env.js) for the shared harness.

## Three Tiers

### Tier 1: Unit Tests
Pure functions tested with real filesystem operations in temp dirs. No daemon, no Claude Code. Examples: `secure-fs`, `session-stats` JSONL parsing, `findGitRoot`.

### Tier 2: Integration Tests
Multiple modules wired together against an isolated directory. Real daemon, real pool.json, real discovery. Examples: `getSessions()` with crafted PID/signal files, daemon client communication.

### Tier 3: E2E Tests
Real Claude Code sessions observed through real discovery/API. Manual PID file creation (simulating hook behavior) because plugin hooks hardcode `~/.open-cockpit/`. Each test maximizes coverage per API call.

## What We Don't Test

- **Electron renderer UI** — DOM rendering, CodeMirror, CSS. These need visual/manual verification.
- **Platform-specific subprocess output** — `lsof`, `ps eww` parsing is tested via `parse-origins.test.js` (existing). Actual subprocess calls are platform-dependent.
- **Auto-updater** — requires Electron runtime + network + code signing. Manual QA only.

## Test File Naming

- `test/<module>.test.js` — unit tests for `src/<module>.js`
- `test/<module>-integration.test.js` — integration tests
- `test/e2e-<feature>.test.js` — end-to-end tests with Claude Code
- `test/helpers/` — shared utilities, not test files
- `test/fixtures/` — static test data (JSONL files, etc.)

## Running Tests

```bash
npm test              # all tests (includes E2E — costs API credits)
npm test -- --grep "Tier 1"  # unit tests only (free)
npm test -- --grep "Tier 2"  # integration tests only (free)
npm test -- --grep "e2e"     # E2E tests only (costs ~6 Claude Code calls)
```
