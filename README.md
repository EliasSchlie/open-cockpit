# Claude Sessions

Electron app for managing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session intentions.

Session sidebar lists active Claude processes. Each session has a markdown intention file with a live preview editor (CodeMirror 6, Obsidian-style — renders inline, shows raw syntax on the active line).

## Setup

```bash
npm install
npm start
```

Requires two Claude Code hooks to be configured — see [docs/hooks.md](docs/hooks.md).

## Features

- Session sidebar (auto-refreshes, shows alive/dead status)
- Live preview markdown editor
- Auto-save (500ms debounce)
- External change detection (updates when Claude writes to the file)
