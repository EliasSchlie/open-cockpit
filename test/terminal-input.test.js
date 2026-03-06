import { describe, it, expect } from "vitest";
import { parseTerminalHasInput } from "../src/terminal-input.js";

// These tests verify ground-truth detection of text in Claude's TUI input box
// by parsing the rendered terminal buffer with a headless terminal emulator.

describe("parseTerminalHasInput", () => {
  // Simulate Claude's idle prompt (no input)
  const emptyPrompt = [
    "\x1b[2J\x1b[H", // clear screen, cursor home
    " ▐▛███▜▌   Claude Code v2.1.69\r\n",
    "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
    "  ▘▘ ▝▝    /Users/test\r\n",
    "\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "❯\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "  ~  Opus 4.6  0%\r\n",
  ].join("");

  // Same but with text typed in the input box
  const inputWithText = [
    "\x1b[2J\x1b[H",
    " ▐▛███▜▌   Claude Code v2.1.69\r\n",
    "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
    "  ▘▘ ▝▝    /Users/test\r\n",
    "\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "❯ fix the login bug\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "  ~  Opus 4.6  0%\r\n",
  ].join("");

  // Multi-line input (shift+enter)
  const multiLineInput = [
    "\x1b[2J\x1b[H",
    " ▐▛███▜▌   Claude Code v2.1.69\r\n",
    "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
    "  ▘▘ ▝▝    /Users/test\r\n",
    "\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "❯ first line\r\n",
    "  second line\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "  ~  Opus 4.6  0%\r\n",
  ].join("");

  // Narrower terminal (60 cols) — separator lines are shorter
  const narrowEmpty = [
    "\x1b[2J\x1b[H",
    " ▐▛███▜▌   Claude Code v2.1.69\r\n",
    "▝▜█████▛▘  Opus 4.6\r\n",
    "\r\n",
    "────────────────────────────────────────────────────\r\n",
    "❯\r\n",
    "────────────────────────────────────────────────────\r\n",
  ].join("");

  const narrowWithInput = [
    "\x1b[2J\x1b[H",
    " ▐▛███▜▌   Claude Code v2.1.69\r\n",
    "▝▜█████▛▘  Opus 4.6\r\n",
    "\r\n",
    "────────────────────────────────────────────────────\r\n",
    "❯ hello world\r\n",
    "────────────────────────────────────────────────────\r\n",
  ].join("");

  // After /clear — prompt still visible
  const afterClear = [
    "\x1b[2J\x1b[H",
    " ▐▛███▜▌   Claude Code v2.1.69\r\n",
    "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
    "  ▘▘ ▝▝    /Users/test\r\n",
    "\r\n",
    "❯ /clear \r\n",
    "  ⎿  (no content)\r\n",
    "\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "❯\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
  ].join("");

  // This is the key test: text written via direct daemon bypass
  // The old keystroke tracking would NOT detect this.
  // Buffer parsing MUST detect it.
  const bypassText = [
    "\x1b[2J\x1b[H",
    " ▐▛███▜▌   Claude Code v2.1.69\r\n",
    "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
    "  ▘▘ ▝▝    /Users/test\r\n",
    "\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
    "❯ sneaky bypass text\r\n",
    "────────────────────────────────────────────────────────────────────────────────\r\n",
  ].join("");

  it("detects empty input box", async () => {
    expect(await parseTerminalHasInput(emptyPrompt, 80)).toBe(false);
  });

  it("detects text in input box", async () => {
    expect(await parseTerminalHasInput(inputWithText, 80)).toBe(true);
  });

  it("detects multi-line input", async () => {
    expect(await parseTerminalHasInput(multiLineInput, 80)).toBe(true);
  });

  it("works with narrow terminal", async () => {
    expect(await parseTerminalHasInput(narrowEmpty, 60)).toBe(false);
    expect(await parseTerminalHasInput(narrowWithInput, 60)).toBe(true);
  });

  it("detects empty after /clear", async () => {
    // Last ❯ is the empty one after /clear
    expect(await parseTerminalHasInput(afterClear, 80)).toBe(false);
  });

  it("detects text written via daemon bypass", async () => {
    // This is the critical test — keystroke tracking would miss this
    expect(await parseTerminalHasInput(bypassText, 80)).toBe(true);
  });

  it("returns false for empty buffer", async () => {
    expect(await parseTerminalHasInput("", 80)).toBe(false);
  });

  it("returns false for buffer without prompt", async () => {
    expect(await parseTerminalHasInput("just some text\r\n", 80)).toBe(false);
  });

  // Regression: pollTerminalInput previously used per-slot `read-buffer` daemon
  // requests that silently failed (returning "") when the daemon didn't support
  // that command. This caused parseTerminalHasInput to always return false,
  // hiding typed text. The fix uses `list` (which returns all buffers) instead.
  // This test verifies the core invariant: a buffer with visible text after the
  // prompt MUST return true, never be silently swallowed by empty-string fallback.
  it("never misses input when given the actual buffer (regression: silent empty fallback)", async () => {
    const bufferWithText = [
      "\x1b[2J\x1b[H",
      " ▐▛███▜▌   Claude Code v2.1.69\r\n",
      "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
      "  ▘▘ ▝▝    /Users/test\r\n",
      "\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
      "❯ implement the feature\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
    ].join("");

    // With the actual buffer: must detect input
    expect(await parseTerminalHasInput(bufferWithText)).toBe(true);

    // With empty string (what readTerminalBuffer returned on daemon error):
    // must NOT detect input — this is correct behavior, but the bug was that
    // pollTerminalInput always got empty strings due to silent daemon errors
    expect(await parseTerminalHasInput("")).toBe(false);
  });
});
