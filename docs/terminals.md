# Terminal Tab Model

## Tab types

- **Pool sessions** (non-external): The first terminal tab shows the **live Claude TUI** from the pool slot (attached via daemon). Users interact with Claude directly through this tab.
- **External sessions** (started outside the app): First tab is a fresh shell, since the app doesn't own their terminal.
- **Additional tabs** (via "+" in the tab bar): Always fresh shells at the session's cwd.

Tab labeled "Claude" for pool TUI, "Terminal N" for shells. Pool TUI tabs detach on close (don't kill the daemon PTY). Falls back to fresh shell if pool slot not found or attach fails.

## Pool TUI attach strategy

`attachPoolTerminal` fetches the PTY's current dimensions and replay buffer from the daemon, creates xterm at those exact dimensions, and writes the buffer directly. This avoids two pitfalls:

1. **xterm.js reflow garbling**: Writing an 80×24 buffer into a 200×50 terminal causes xterm to reflow lines, corrupting TUI cursor positioning.
2. **macOS SIGWINCH suppression**: macOS's XNU kernel skips SIGWINCH when `ioctl(TIOCSWINSZ)` sets the same dimensions (`bcmp` check in `tty_ioctl`). If the PTY already matches the window size, relying on SIGWINCH for a redraw silently fails.

`reportTerminalDims` still reports window size to pool-manager so new pool slots spawn at the correct dimensions from the start (reduces initial resize flash), but it's no longer required for correctness.

## Programmatic terminal access

Sessions can discover and interact with their own terminal tabs via the `session-terminals` API and `cockpit-cli term` commands. All `term` subcommands auto-detect the caller's session ID by walking PID ancestry (checks `~/.open-cockpit/session-pids/<PID>`), so no target is needed when calling from within a Claude session.

**High-level commands (recommended):**
- `cockpit-cli term exec 'npm test'` — one-shot: opens ephemeral shell → runs command → returns output → closes tab
- `cockpit-cli term run 1 'make build'` — runs command in an existing shell tab, returns output when done

**Low-level primitives:**
- `cockpit-cli term ls` — list terminal tabs (index, label, TUI flag)
- `cockpit-cli term read 1` / `term write 1 'text'` / `term key 1 enter` — direct tab I/O
- `cockpit-cli term open` / `term close 1` — manage tabs
- `cockpit-cli term watch 1` — follow output in real-time

Tabs are addressed by index (0 = first tab, typically TUI for pool sessions). See [api.md](api.md) for full reference.
