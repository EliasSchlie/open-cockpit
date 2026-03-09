# Terminal Tab Model

## Tab types

- **Pool sessions** (non-external): The first terminal tab shows the **live Claude TUI** from the pool slot (attached via daemon). Users interact with Claude directly through this tab.
- **External sessions** (started outside the app): First tab is a fresh shell, since the app doesn't own their terminal.
- **Additional tabs** (via "+" in the tab bar): Always fresh shells at the session's cwd.

Tab labeled "Claude" for pool TUI, "Terminal N" for shells. Pool TUI tabs detach on close (don't kill the daemon PTY). Falls back to fresh shell if pool slot not found or attach fails.

## Pool TUI attach strategy

`attachPoolTerminal` skips the daemon's replay buffer entirely — recycled pool slots' buffers contain old session content from before `/clear`. Instead, it forces a SIGWINCH to trigger Claude's clean redraw. macOS's XNU kernel skips SIGWINCH when `ioctl(TIOCSWINSZ)` sets identical dimensions, so the code "jiggles" the PTY (shrinks by 1 column, then restores) to guarantee delivery.

`reportTerminalDims` reports window size to pool-manager so new pool slots spawn at the correct dimensions from the start (reduces initial resize flash).

## TUI reflow prevention

xterm.js reflow on resize treats all content as reflowable text, re-wrapping lines at the new column width. Claude's Ink-based TUI uses absolute cursor positioning (ANSI CSI sequences like `\e[row;colH`), which reflow garbles: the input bar shifts to the middle of the screen, UI elements overlay each other, and content appears at wrong positions.

`setupTerminalResize` in `dock-helpers.js` handles this: before `fitAddon.fit()` resizes a pool TUI terminal, it checks if dimensions will change. If so, it clears the xterm buffer (scrollback + visible screen via `\x1b[2J\x1b[H`) so there's nothing to reflow. The subsequent `ptyResize` sends SIGWINCH, triggering Claude's full redraw at the correct dimensions.

Shell terminals are unaffected — reflow is acceptable for normal text output.

**Key invariant**: Pool TUI terminals must never have cursor-positioned content in xterm's buffer when a resize occurs. Skip the buffer entirely (initial attach) or clear before resize (ongoing resizes).

## Reconnect handling

When reconnecting to a session after app restart, `reconnectTerminal()` writes the PTY's saved buffer at matching dimensions. If the window has since changed size, `fitAddon.fit()` would reflow the buffer, garbling TUI content. To prevent this, entries are flagged with `_hasReconnectBuffer` — on the first resize, `setupTerminalResize` clears the buffer and lets SIGWINCH trigger a full redraw.

## API-created tabs

Tabs created via `cockpit-cli term open` or the `session-term-open` API are discovered by the renderer via `discoverExtraTerminals()`, which queries the daemon for all terminals belonging to the session and attaches any that aren't already tracked. The renderer is notified via the `api-term-opened` IPC event.

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
