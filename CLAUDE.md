# Claude Sessions

Electron app for managing Claude Code sessions.

## Architecture

- `src/main.js` — Main process: window creation, IPC handlers for session/intention CRUD
- `src/preload.js` — Context bridge exposing `api` to renderer
- `src/renderer.js` — UI logic: session list, markdown editor with live preview
- `src/index.html` + `src/styles.css` — UI layout and Catppuccin-themed dark styling

## Key paths

- `~/.claude/session-pids/` — PID → session ID mappings (written by dotfiles hook)
- `~/.intentions/<session_id>.md` — Intention files (one per session)

## Dev

```bash
npm start      # Run the app
npm run dev    # Run with --dev flag
```

## Conventions

- Electron with contextIsolation + preload (no nodeIntegration in renderer)
- markdown-it for rendering
- Auto-save with 500ms debounce
