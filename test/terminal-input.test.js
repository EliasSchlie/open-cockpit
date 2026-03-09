import { describe, it, expect } from "vitest";
import {
  parseTerminalHasInput,
  checkTerminalInputs,
} from "../src/terminal-input.js";

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
    expect(await parseTerminalHasInput(emptyPrompt, 80)).toBe("");
  });

  it("returns text from input box", async () => {
    expect(await parseTerminalHasInput(inputWithText, 80)).toBe(
      "fix the login bug",
    );
  });

  it("detects multi-line input", async () => {
    // Only the prompt line is returned (first line with ❯)
    expect(await parseTerminalHasInput(multiLineInput, 80)).toBe("first line");
  });

  it("works with narrow terminal", async () => {
    expect(await parseTerminalHasInput(narrowEmpty, 60)).toBe("");
    expect(await parseTerminalHasInput(narrowWithInput, 60)).toBe(
      "hello world",
    );
  });

  it("detects empty after /clear", async () => {
    // Last ❯ is the empty one after /clear
    expect(await parseTerminalHasInput(afterClear, 80)).toBe("");
  });

  it("returns text written via daemon bypass", async () => {
    // This is the critical test — keystroke tracking would miss this
    expect(await parseTerminalHasInput(bypassText, 80)).toBe(
      "sneaky bypass text",
    );
  });

  it("returns empty string for empty buffer", async () => {
    expect(await parseTerminalHasInput("", 80)).toBe("");
  });

  it("returns empty string for buffer without prompt", async () => {
    expect(await parseTerminalHasInput("just some text\r\n", 80)).toBe("");
  });

  // Test: buffer missing alternate screen switch (truncated at 100KB)
  // When the daemon buffer exceeds BUFFER_SIZE, the leading alt-screen switch
  // is lost. parseTerminalHasInput should prepend it as a fallback.
  it("detects input when alternate screen switch is truncated", async () => {
    // Buffer WITHOUT the alt-screen switch — simulates truncation
    const truncatedBuffer = [
      // No \x1b[?1049h here — it was before the truncation point
      "\x1b[2J\x1b[H",
      " ▐▛███▜▌   Claude Code v2.1.69\r\n",
      "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
      "  ▘▘ ▝▝    /Users/test\r\n",
      "\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
      "❯ truncated alt screen test\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
    ].join("");

    expect(await parseTerminalHasInput(truncatedBuffer, 80)).toBe(
      "truncated alt screen test",
    );
  });

  // Test: buffer with explicit alternate screen mode
  it("detects input with alternate screen enabled", async () => {
    const altScreenBuffer = [
      "\x1b[?1049h", // switch to alt screen
      "\x1b[2J\x1b[H",
      " ▐▛███▜▌   Claude Code v2.1.69\r\n",
      "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
      "  ▘▘ ▝▝    /Users/test\r\n",
      "\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
      "❯ alt screen prompt\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
    ].join("");

    expect(await parseTerminalHasInput(altScreenBuffer, 80)).toBe(
      "alt screen prompt",
    );
  });

  // Regression: buffer truncation causes TUI decorations to bleed into prompt line
  it("strips TUI decoration artifacts from prompt text", async () => {
    // Simulates truncated buffer where box-drawing and geometric chars
    // appear after the prompt character on the same line
    const decorationBleed = [
      "\x1b[2J\x1b[H",
      " ▐▛███▜▌   Claude Code v2.1.69\r\n",
      "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
      "  ▘▘ ▝▝    /Users/test\r\n",
      "\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
      "❯ \x1b[199C─   ▪\r\n", // cursor right + decoration chars at end of line
      "────────────────────────────────────────────────────────────────────────────────\r\n",
    ].join("");
    expect(await parseTerminalHasInput(decorationBleed, 200)).toBe("");
  });

  it("preserves real input even when mixed with decoration chars", async () => {
    // Real input that happens to contain text after stripping decorations
    const mixedInput = [
      "\x1b[2J\x1b[H",
      " ▐▛███▜▌   Claude Code v2.1.69\r\n",
      "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
      "  ▘▘ ▝▝    /Users/test\r\n",
      "\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
      "❯ fix the bug\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
    ].join("");
    expect(await parseTerminalHasInput(mixedInput, 80)).toBe("fix the bug");
  });

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
    expect(await parseTerminalHasInput(bufferWithText)).toBe(
      "implement the feature",
    );

    // With empty string (what readTerminalBuffer returned on daemon error):
    // must NOT detect input — this is correct behavior, but the bug was that
    // pollTerminalInput always got empty strings due to silent daemon errors
    expect(await parseTerminalHasInput("")).toBe("");
  });
});

// Integration test: verifies that checkTerminalInputs (used by pollTerminalInput)
// correctly detects input from daemon `list` response buffers.
// This is the test that would have caught the original bug — if the function
// receives empty buffers (as happened with the broken `read-buffer` path),
// it correctly returns false; with real buffers, it returns true.
describe("checkTerminalInputs", () => {
  const makeBuffer = (promptText) =>
    [
      "\x1b[2J\x1b[H",
      " ▐▛███▜▌   Claude Code v2.1.69\r\n",
      "▝▜█████▛▘  Opus 4.6 · Claude Max\r\n",
      "  ▘▘ ▝▝    /Users/test\r\n",
      "\r\n",
      "────────────────────────────────────────────────────────────────────────────────\r\n",
      `❯${promptText}\r\n`,
      "────────────────────────────────────────────────────────────────────────────────\r\n",
    ].join("");

  it("returns input text from real daemon list buffers", async () => {
    const ptys = [
      { termId: 1, buffer: makeBuffer(" fix the bug") },
      { termId: 2, buffer: makeBuffer("") },
      { termId: 3, buffer: makeBuffer(" deploy to prod") },
      { termId: 99, buffer: makeBuffer(" not fresh — should be ignored") },
    ];
    const freshTermIds = new Set([1, 2, 3]);

    const results = await checkTerminalInputs(ptys, freshTermIds);

    expect(results.get(1)).toBe("fix the bug");
    expect(results.get(2)).toBe("");
    expect(results.get(3)).toBe("deploy to prod");
    expect(results.has(99)).toBe(false); // not fresh, excluded
  });

  it("returns empty strings when daemon returns empty buffers (regression)", async () => {
    // Simulates the old bug: daemon returns empty/missing buffers
    const ptys = [
      { termId: 1, buffer: "" },
      { termId: 2, buffer: undefined },
    ];
    const freshTermIds = new Set([1, 2]);

    const results = await checkTerminalInputs(ptys, freshTermIds);

    expect(results.get(1)).toBe("");
    expect(results.get(2)).toBe("");
  });

  it("uses PTY cols and rows from daemon response", async () => {
    const ptys = [
      {
        termId: 1,
        buffer: makeBuffer(" with dimensions"),
        cols: 100,
        rows: 30,
      },
    ];
    const freshTermIds = new Set([1]);

    const results = await checkTerminalInputs(ptys, freshTermIds);
    expect(results.get(1)).toBe("with dimensions");
  });

  it("returns empty map when no fresh PTYs in list", async () => {
    const ptys = [{ termId: 99, buffer: makeBuffer(" some text") }];
    const freshTermIds = new Set([1, 2]);

    const results = await checkTerminalInputs(ptys, freshTermIds);

    expect(results.size).toBe(0);
  });
});
