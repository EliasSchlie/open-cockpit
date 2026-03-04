# Claude Sessions

Electron app for managing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session intentions.

Lists active Claude sessions with a live preview markdown editor (CodeMirror 6, Obsidian-style inline rendering).

## Setup

```bash
npm install
npm start
```

## Plugin

This repo includes a Claude Code plugin that maps session PIDs to IDs (required for the app to discover sessions).

```bash
claude plugin install claude-sessions@elias-tools
```

The plugin adds a `SessionStart` hook that writes `~/.claude/session-pids/<PID>` → session ID.
