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

/**
 * Parse a terminal buffer to detect if Claude's input box has text.
 * @param {string} buffer - Raw PTY output buffer
 * @param {number} cols - Terminal column width
 * @returns {Promise<boolean>} true if there's text after the prompt
 */
async function parseTerminalHasInput(buffer, cols = 200) {
  if (!buffer) return false;

  const term = new Terminal({ cols, rows: 50, allowProposedApi: true });

  // Write buffer and wait for it to be processed
  await new Promise((resolve) => {
    term.write(buffer, resolve);
  });

  // Scan screen bottom-up for the last line containing the prompt char
  let lastPromptText = null;
  for (let i = term.rows - 1; i >= 0; i--) {
    const line = term.buffer.active.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.includes(PROMPT_CHAR)) {
      lastPromptText = text;
      break;
    }
  }

  term.dispose();

  if (!lastPromptText) return false;

  // Extract text after the prompt character
  const afterPrompt = lastPromptText
    .split(PROMPT_CHAR)
    .slice(1)
    .join(PROMPT_CHAR);
  return afterPrompt.trim().length > 0;
}

/**
 * Check which fresh terminals have input, given a daemon `list` response.
 * Pure function — no daemon calls, no side effects.
 * @param {Array<{termId: number, buffer: string}>} ptys - PTY list from daemon
 * @param {Set<number>} freshTermIds - termIds of fresh pool slots
 * @returns {Promise<Map<number, boolean>>} termId → hasInput
 */
async function checkTerminalInputs(ptys, freshTermIds) {
  const freshPtys = ptys.filter((p) => freshTermIds.has(p.termId));
  const results = await Promise.all(
    freshPtys.map(async (pty) => ({
      termId: pty.termId,
      hasInput: await parseTerminalHasInput(pty.buffer || ""),
    })),
  );
  const map = new Map();
  for (const { termId, hasInput } of results) {
    map.set(termId, hasInput);
  }
  return map;
}

module.exports = { parseTerminalHasInput, checkTerminalInputs };
