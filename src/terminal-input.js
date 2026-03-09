/**
 * Detect whether Claude's TUI input box has text by parsing the terminal buffer.
 *
 * Renders the raw PTY output with a headless terminal emulator, then checks
 * the last line containing the `❯` prompt character for non-whitespace content.
 * This is true ground truth — catches text regardless of how it was written
 * (IPC, API, or direct daemon socket).
 */

const { Terminal } = require("@xterm/headless");

const PROMPT_CHAR = "❯";
// Claude Code's TUI renders in the alternate screen buffer. If the daemon's
// 100KB buffer was truncated and lost the original \x1b[?1049h switch,
// we prepend it as a fallback so xterm renders into the correct buffer.
const ALT_SCREEN_ON = "\x1b[?1049h";

/**
 * Scan terminal buffer lines in [start, end) range (bottom-up) for the prompt.
 * Returns text after the prompt character, or null if not found.
 */
function findPromptInRange(buf, start, end) {
  for (let i = end - 1; i >= start; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.includes(PROMPT_CHAR)) {
      return text.split(PROMPT_CHAR).slice(1).join(PROMPT_CHAR).trim();
    }
  }
  return null;
}

/**
 * Scan a terminal for the prompt character and return text after it.
 * Checks active viewport first, then scrollback.
 */
function extractPromptText(term) {
  const buf = term.buffer.active;

  // Active viewport (most common case)
  const result = findPromptInRange(buf, 0, term.rows);
  if (result != null) return result;

  // Scrollback (prompt scrolled up due to long input or rendering artifacts)
  const scrollResult = findPromptInRange(buf, 0, buf.viewportY);
  return scrollResult ?? "";
}

/**
 * Parse a terminal buffer to extract text from Claude's input box.
 * @param {string} buffer - Raw PTY output buffer
 * @param {number} cols - Terminal column width (should match actual PTY)
 * @param {number} rows - Terminal row count (should match actual PTY)
 * @returns {Promise<string>} trimmed text after the prompt, or "" if none
 */
async function parseTerminalHasInput(buffer, cols = 200, rows = 50) {
  if (!buffer) return "";

  // Try with the buffer as-is first (handles both main and alt screen)
  let result = await tryParse(buffer, cols, rows);
  if (result) return result;

  // If not found, the buffer may have been truncated and lost the alternate
  // screen switch. Prepend it and retry — Claude's TUI renders in alt screen.
  if (!buffer.includes(ALT_SCREEN_ON)) {
    result = await tryParse(ALT_SCREEN_ON + buffer, cols, rows);
    if (result) return result;
  }

  return "";
}

async function tryParse(buffer, cols, rows) {
  const term = new Terminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
  });

  await new Promise((resolve) => {
    term.write(buffer, resolve);
  });

  const result = extractPromptText(term);
  term.dispose();
  return result;
}

/**
 * Check which fresh terminals have input, given a daemon `list` response.
 * Pure function — no daemon calls, no side effects.
 * @param {Array<{termId: number, buffer: string, cols?: number, rows?: number}>} ptys
 * @param {Set<number>} freshTermIds - termIds of fresh pool slots
 * @returns {Promise<Map<number, string>>} termId → input text (empty string if none)
 */
async function checkTerminalInputs(ptys, freshTermIds) {
  const freshPtys = ptys.filter((p) => freshTermIds.has(p.termId));
  const results = await Promise.all(
    freshPtys.map(async (pty) => ({
      termId: pty.termId,
      inputText: await parseTerminalHasInput(
        pty.buffer || "",
        pty.cols || 200,
        pty.rows || 50,
      ),
    })),
  );
  const map = new Map();
  for (const { termId, inputText } of results) {
    map.set(termId, inputText);
  }
  return map;
}

module.exports = { parseTerminalHasInput, checkTerminalInputs };
