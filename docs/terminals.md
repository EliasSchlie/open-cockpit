# Terminal Tab Model

## Tab types

- **Pool sessions** (non-external): The first terminal tab shows the **live Claude TUI** from the pool slot (attached via daemon). Users interact with Claude directly through this tab.
- **External sessions** (started outside the app): First tab is a fresh shell, since the app doesn't own their terminal.
- **Additional tabs** (via "+" in the tab bar): Always fresh shells at the session's cwd.

Tab labeled "Claude" for pool TUI, "Terminal N" for shells. Pool TUI tabs detach on close (don't kill the daemon PTY). Falls back to fresh shell if pool slot not found or attach fails.

## Pool TUI attach strategy

`attachPoolTerminal` fetches the PTY's current dimensions and replay buffer from the daemon, creates xterm at those exact dimensions, and writes the buffer directly. This avoids xterm.js reflow garbling (writing an 80×24 buffer into a 200×50 terminal causes line re-wrapping that corrupts cursor-positioned content). The buffer is clean because `offloadSession` clears it via the daemon's `clear-buffer` command before recycling.

`reportTerminalDims` reports window size to pool-manager so new pool slots spawn at the correct dimensions from the start (reduces initial resize flash).

## Resize behavior

When the terminal container resizes (window resize, split drag, tab switch), `fitAddon.fit()` adjusts xterm dimensions and sends `ptyResize` → SIGWINCH to the PTY process. Claude's TUI redraws fully on SIGWINCH, so any momentary reflow garbling self-corrects immediately.

Previous approaches tried clearing the xterm buffer before resize to prevent reflow artifacts, but this caused blank terminals because the clear-to-SIGWINCH-redraw path is inherently racy. The simpler approach (let reflow happen, trust SIGWINCH redraw) is more reliable.

## Reconnect handling

When reconnecting to a session after app restart, `reconnectTerminal()` writes the PTY's saved buffer at matching dimensions. If the window has since changed size, `fitAddon.fit()` will trigger a SIGWINCH, and Claude redraws at the correct dimensions.

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
