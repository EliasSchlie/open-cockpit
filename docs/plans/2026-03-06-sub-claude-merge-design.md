# Sub-Claude → Open Cockpit: Merge Design

## Goal

Replace sub-claude plugin with open-cockpit's pool. Claude sessions use `cockpit-cli` instead of `sub-claude` to spawn and manage sub-sessions. Both user and model share the same pool.

## Features

### 1. Parent-Child Session Graph

**Storage:** `~/.open-cockpit/session-graph.json`

```json
{
  "abc123-...": {
    "parentSessionId": "def456-...",
    "initiator": "model",
    "createdAt": "2026-03-06T12:00:00Z"
  },
  "def456-...": {
    "parentSessionId": null,
    "initiator": "user",
    "createdAt": "2026-03-06T11:50:00Z"
  }
}
```

- **initiator**: `"user"` (human started via UI/terminal) or `"model"` (Claude started via `cockpit-cli start`)
- Written atomically on `pool-start` and `pool-followup`
- CLI auto-detects parent by walking PPID chain → `~/.open-cockpit/session-pids/` (same technique sub-claude uses)
- API: `pool-start` and `pool-followup` accept optional `parentSessionId` field
- New API command: `get-session-graph` returns full graph
- `get-sessions` response enriched with `parentSessionId`, `initiator`, `children` (derived)

**Sidebar use:** The graph is flat (fast lookup by sessionId), but the app can derive tree structure for nesting by following `parentSessionId` chains.

### 2. Output Verbosity Filtering (`-v`)

CLI-only feature — API always returns raw terminal buffers.

| Level | What it shows |
|-------|---------------|
| `raw` (default) | Terminal buffer as-is |
| `response` | Last assistant message only (parsed from JSONL) |
| `conversation` | All user + assistant messages (parsed from JSONL) |
| `full` | Terminal buffer, ANSI-stripped |

Applied to: `result`, `capture`, `wait`, `start --block`, `followup --block`

Implementation: Reuses `find_jsonl()` + jq patterns already in the `log` command.

### 3. Session Pinning

- Pool slot gets `pinnedUntil` field (ISO timestamp or `null`)
- LRU eviction in `withFreshSlot` skips pinned sessions
- API: `pool-pin { sessionId, duration }` and `pool-unpin { sessionId }`
- CLI: `pin <id> [seconds]` (default 120s) and `unpin <id>`
- Expired pins auto-cleared on next eviction check

### 4. Stop Command

- CLI: `stop <id>` — sends Escape + Ctrl-C to session terminal
- API: `pool-stop-session { sessionId }` — same, via daemon write
- Does NOT kill the slot or remove from pool — just interrupts the running task
- Session returns to `idle` after Claude stops

### 5. Skill File

`skills/sub-claude/SKILL.md` in the open-cockpit repo. Keeps the skill name `sub-claude` for familiarity — Claude already knows to invoke it. Content ported from sub-claude's skill, commands changed to `cockpit-cli`.

## Files Changed

| File | Change |
|------|--------|
| `bin/cockpit-cli` | Add `-v` flag, `pin`/`unpin`/`stop` commands, `parentSessionId` detection |
| `src/main.js` | Add `pool-pin`, `pool-unpin`, `pool-stop-session`, `get-session-graph` handlers; write session graph on `pool-start`/`pool-followup`; enrich `get-sessions` with graph data |
| `src/pool.js` | Add `pinnedUntil` to slot; skip pinned in `selectShrinkCandidates` |
| `skills/sub-claude/SKILL.md` | New file — skill for Claude to use cockpit-cli |
| `test/pool.test.js` | Tests for pinning logic |
| `test/cockpit-cli.test.js` | Tests for new CLI commands |

## Not Included

- Sub-claude's custom agents (`sub-claude run code-review`, etc.) — these are separate scripts, not part of the core pool. Can be ported later or kept as standalone.
- Queue system with FIFO ordering — open-cockpit's LRU eviction is sufficient for shared pools.
- Depth limiting — can be added later if recursive sub-agent spawning becomes an issue.
