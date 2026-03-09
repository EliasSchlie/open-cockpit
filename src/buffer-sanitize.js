/**
 * Buffer sanitization — cleans up the start of a truncated terminal buffer
 * so replay doesn't produce rendering artifacts.
 *
 * Extracted from pty-daemon.js for testability.
 */

const BUFFER_SIZE = 100_000;

// Screen-reset sequences that mark the start of a clean terminal frame.
const SCREEN_CLEAR = "\x1b[2J"; // Erase entire display
const ALT_SCREEN_ON = "\x1b[?1049h"; // Switch to alternate screen buffer
// Max bytes to scan for a screen-reset boundary (don't discard >25% of buffer)
const RESET_SCAN_LIMIT = Math.floor(BUFFER_SIZE / 4);

/**
 * Clean up the start of a truncated buffer for artifact-free replay.
 * 1. Skip UTF-8 continuation bytes (split multi-byte chars)
 * 2. Skip partial ANSI escape sequences
 * 3. Trim to first screen-reset boundary (prevents mid-redraw artifacts)
 */
function sanitizeBufferStart(buf) {
  if (!buf) return buf;

  // Step 1: Skip leading UTF-8 continuation bytes (0x80-0xBF)
  let start = 0;
  while (
    start < buf.length &&
    buf.charCodeAt(start) >= 0x80 &&
    buf.charCodeAt(start) <= 0xbf
  ) {
    start++;
  }

  // Step 2: Skip a partial ANSI escape at the start
  const escIdx = buf.indexOf("\x1b", start);
  if (escIdx >= 0 && escIdx < start + 40) {
    const afterEsc = buf.substring(escIdx, escIdx + 40);
    const complete =
      /^\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]|\].*?(?:\x07|\x1b\\)|[()][0-9A-Za-z]|.)/.test(
        afterEsc,
      );
    if (!complete) {
      const nextEsc = buf.indexOf("\x1b", escIdx + 1);
      start = nextEsc > 0 ? nextEsc : escIdx + 1;
    }
  }

  // Step 3: Find the first screen-reset boundary after the truncation point.
  // This marks the beginning of a complete redraw frame — everything before
  // it is a partial frame that would cause rendering artifacts on replay.
  const scanEnd = Math.min(buf.length, start + RESET_SCAN_LIMIT);
  let resetIdx = -1;

  const altIdx = buf.indexOf(ALT_SCREEN_ON, start);
  if (altIdx >= 0 && altIdx < scanEnd) resetIdx = altIdx;

  const clearIdx = buf.indexOf(SCREEN_CLEAR, start);
  if (clearIdx >= 0 && clearIdx < scanEnd) {
    // Prefer the earlier reset point
    if (resetIdx < 0 || clearIdx < resetIdx) resetIdx = clearIdx;
  }

  if (resetIdx > start) start = resetIdx;

  return start > 0 ? buf.slice(start) : buf;
}

module.exports = {
  sanitizeBufferStart,
  BUFFER_SIZE,
  ALT_SCREEN_ON,
};
