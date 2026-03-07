# Pool Management

## Commands

```bash
cockpit-cli pool init           # start 5-slot pool
cockpit-cli pool init 8         # explicit size — always overprovision
cockpit-cli pool status         # inspect slots, health
cockpit-cli pool resize 8       # grow (adds slots)
cockpit-cli pool resize 3       # shrink (offloads idle slots gracefully)
cockpit-cli pool destroy        # kill everything
```

Pool state lives in `~/.open-cockpit/pool.json`.

**Shared pool:** The pool is shared between the user (via Open Cockpit UI) and Claude sessions (via `cockpit-cli`). Both see the same sessions.

> **Pool init and resize run `claude` to create new slots.** This may cause any currently-running Bash tool calls from other Claude sessions to lose output. Plan init before work starts or during idle periods.

## Overprovisioning

Sub-agents, other Claude instances, and hooks all consume slots. A pool that looks big enough at launch saturates quickly once nested work kicks in. Start larger than you think you need.
