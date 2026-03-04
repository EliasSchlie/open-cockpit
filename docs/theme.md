# Theme & Directory Color Coding

## Color scheme

Dark black (`#0a0a0a`) background with neon red (`#ff1a1a`) accents.

- CSS vars: `:root` in `src/styles.css`
- CodeMirror colors: hardcoded in `src/renderer.js` theme objects (`livePreviewTheme`, `darkTheme`)
- xterm theme: minimal (background + cursor only) — shell's own ANSI colors are preserved

## Session color coding

Each session gets a colored sidebar indicator and editor header bar based on its working directory.

**How colors are assigned:**
- Deterministic hash — same directory always gets the same color from a 10-color neon palette
- Git repo subdirs all share the repo root's color (detected via `.git` directory walk-up in `main.js`)
- Worktree paths (`.claude/worktrees/xxx`, `.wt/xxx`) resolve to parent project's color
- Home directory (`~`) gets no color (transparent)

**Implementation:**
- `main.js` — `getSessions()` walks up from `cwd` looking for `.git` *directory* (not file — worktrees have `.git` files). Returns `gitRoot` per session.
- `renderer.js` — `getColorKey(session)` normalizes path (strip worktree suffix, use gitRoot if available), then `getDirColor(session)` checks user config, falls back to hash.

## User color overrides

Config file: `~/.open-cockpit/colors.json`

```json
{
  "~/Documents/Projects/my-app": "#ff00ff",
  "~/Documents/Projects/boring": null
}
```

- Keys are tilde-prefixed paths, matched by longest prefix
- `null` = no color (transparent), string = exact hex color
- Reloads on sidebar refresh (↻ button), no app restart needed
- Served via `get-dir-colors` IPC handler in `main.js`
