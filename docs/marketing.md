# Open Cockpit — Feature Breakdown & Positioning

This document tracks the detailed value propositions, messaging, and feature descriptions for Open Cockpit. Use it as source material for landing pages, plugin descriptions, and outreach.

---

## One-liner

> A mission control for all your Claude Code sessions.

## Elevator pitch

Open Cockpit is a desktop app that turns Claude Code from a single-terminal tool into a multi-agent operating system. It shows every session on your machine in one place, lets agents spawn other agents reliably, gives Claude persistent terminals, and lets you steer agents mid-flight through editable intention files.

---

## Pain points & solutions

### 1. No visibility across sessions

**Pain:** Claude Code runs in terminals. If you have 3–5 sessions going, you're constantly switching tabs to check which ones are done, which need input, and which are still working. There's no central dashboard.

**Solution:** Open Cockpit's sidebar shows every Claude session on your device, grouped and color-coded by status:
- 🟢 **Processing** — actively working
- 🟡 **Idle** — finished, waiting for your input
- ⚪ **Fresh** — pool slot ready, not yet used
- 📦 **Offloaded** — conversation saved, slot freed
- 📁 **Archived** — stored for later reference/resume

A keyboard shortcut jumps directly to the session that most recently became idle — no hunting.

### 2. Recursive agent spawning is broken

**Pain:** Claude Code blocks sessions from spawning other Claude sessions. If you work around the block, the parent session's Bash tool silently loses output — commands return empty strings. This makes multi-agent patterns unreliable.

**Solution:** Open Cockpit sidesteps the problem entirely. Instead of spawning new processes, agents draw from a **pre-started pool** of Claude instances via API or CLI:

```bash
# From inside a Claude session:
id=$(cockpit-cli start "refactor the auth module")
cockpit-cli wait "$id"
result=$(cockpit-cli capture "$id")
cockpit-cli followup "$id" "now add integration tests"
```

The parent session's Bash tool is never involved in spawning — no output collision, no blocking. Sessions track parent-child relationships automatically, so you get a full orchestration graph.

**Key capabilities:**
- Fire-and-forget task dispatch
- Blocking wait for completion
- Multi-turn follow-up conversations
- Live output streaming
- Session pinning (prevent offload during critical work)
- Automatic parent-child tracking

### 3. No persistent shell state

**Pain:** Claude Code's native Bash tool is stateless — every command runs in a fresh shell. You can't SSH into a server, activate a virtualenv, run a database REPL, or interact with anything that requires persistent state.

**Solution:** Open Cockpit provides persistent terminal tabs backed by a PTY daemon. These terminals:
- Survive app restarts (the daemon runs independently)
- Support multiple attached clients (you and Claude can watch the same terminal)
- Maintain full shell state (environment variables, working directory, running processes)
- Can be created, read, written to, and closed programmatically

Each session gets its own terminal tabs. The first tab is the live Claude TUI; additional tabs are shells at the session's working directory.

### 4. No shared terminal visibility

**Pain:** Even with persistent terminals, there's no built-in way for you and Claude to collaborate in the same shell. You can't run a command and have Claude see the result, or vice versa.

**Solution:** Open Cockpit terminals are fully bidirectional. Both human and agent can:
- Run commands and see each other's output in real-time
- Read the terminal buffer at any point
- Send keystrokes (including special keys like Ctrl+C)
- Watch output as it streams

```bash
# High-level (recommended):
cockpit-cli term exec 'npm test'          # ephemeral: open → run → capture → close
cockpit-cli term run 1 'make build'       # run in existing tab, return output

# Low-level primitives:
cockpit-cli term ls                       # list tabs
cockpit-cli term read 1                   # read buffer
cockpit-cli term write 1 'git status'     # type text
cockpit-cli term key 1 enter              # send keystroke
cockpit-cli term watch 1                  # stream output
```

This turns the terminal from a one-way command executor into a shared workspace.

### 5. No way to steer agents mid-flight

**Pain:** Once you give Claude a prompt, you can't adjust its direction without interrupting it. There's no structured way to communicate intent changes while it's working.

**Solution:** Every session has an **intention file** — a markdown document that describes what the agent is working on. The agent writes it on first prompt, and you can edit it at any time through the in-app editor (CodeMirror 6 with live preview). The agent is notified of changes and adapts its work accordingly.

This gives you a lightweight steering mechanism:
- Read what the agent thinks it's doing
- Clarify scope or priorities without stopping work
- Add notes or constraints mid-task
- Review the intention after completion to understand what happened

---

## Key differentiators

| Feature | Native Claude Code | Open Cockpit |
|---------|-------------------|--------------|
| Multi-session overview | ❌ Tab switching | ✅ Unified sidebar |
| Agent spawning agents | ❌ Blocked / breaks output | ✅ Pool-based, reliable |
| Persistent terminals | ❌ Resets between calls | ✅ PTY daemon |
| Shared terminal view | ❌ One-way | ✅ Bidirectional |
| Intention tracking | ❌ None | ✅ Editable markdown per session |
| Session lifecycle | ❌ Start/stop | ✅ Pool with offload/resume/archive |
| Cross-platform | ✅ | ✅ macOS, Linux, Windows |

---

## Target users

1. **Power users** running 3+ Claude sessions simultaneously — need visibility and fast switching
2. **Agent builders** designing multi-agent workflows — need reliable orchestration primitives
3. **DevOps/infra engineers** who need Claude to interact with remote servers — need persistent SSH
4. **Team leads** managing multiple parallel workstreams with Claude — need intention tracking for oversight

---

## Technical facts (for detailed copy)

- Pool size is configurable (default 3 slots, adjustable via UI or API)
- Sessions are reused via `/clear` and `/resume <uuid>` — no process spawn overhead
- LRU offloading: when all slots are busy, the oldest idle session is saved and cleared
- PTY daemon is a separate process — terminals survive app crashes and restarts
- Plugin hooks detect idle/processing transitions via signal files — no polling the transcript
- Unix socket API (`~/.open-cockpit/api.sock`) — same interface for humans and agents
- Session graph tracks parent-child relationships with `initiator: "user" | "model"`
- Setup scripts auto-type commands into fresh sessions (useful for project-specific initialization)
- Custom sessions (Cmd+Shift+N) run outside the pool with custom flags and working directory
- Full keyboard accessibility — every action has a shortcut, every dialog is navigable with arrow keys
