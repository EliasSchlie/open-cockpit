import { describe, it, expect } from "vitest";
import { sanitizeBufferStart } from "../src/buffer-sanitize.js";

// 25% of BUFFER_SIZE (100_000) — matches the internal scan limit
const RESET_SCAN_LIMIT = 25_000;

describe("sanitizeBufferStart", () => {
  describe("empty/null/undefined input", () => {
    it("returns null for null", () => {
      expect(sanitizeBufferStart(null)).toBe(null);
    });

    it("returns undefined for undefined", () => {
      expect(sanitizeBufferStart(undefined)).toBe(undefined);
    });

    it("returns empty string for empty string", () => {
      expect(sanitizeBufferStart("")).toBe("");
    });
  });

  describe("UTF-8 continuation bytes", () => {
    it("skips leading continuation bytes (0x80-0xBF)", () => {
      // Continuation bytes followed by normal ASCII
      const cont = String.fromCharCode(0x80, 0x90, 0xbf);
      const result = sanitizeBufferStart(cont + "hello");
      expect(result).toBe("hello");
    });

    it("skips all bytes if entire buffer is continuation bytes", () => {
      const cont = String.fromCharCode(0x80, 0x90, 0xbf);
      expect(sanitizeBufferStart(cont)).toBe("");
    });

    it("does not skip bytes below 0x80", () => {
      expect(sanitizeBufferStart("hello")).toBe("hello");
    });
  });

  describe("partial ANSI escape sequences", () => {
    it("treats truncated CSI as complete via regex fallback", () => {
      // ESC + any char matches the regex fallback branch, so even a CSI
      // with no final byte is considered "complete" — no skip occurs.
      const partialParams = "0".repeat(39);
      const partial = "\x1b[" + partialParams;
      const complete = "\x1b[32mgreen text";
      const buf = partial + complete;
      expect(sanitizeBufferStart(buf)).toBe(buf);
    });

    it("skips lone ESC at end of buffer (truly incomplete)", () => {
      // Bare ESC with no following byte — regex can't match, so it's incomplete.
      // No next ESC found → start advances past the lone ESC.
      expect(sanitizeBufferStart("\x1b")).toBe("");
    });

    it("leaves complete escape sequences intact", () => {
      const complete = "\x1b[32mgreen text\x1b[0m";
      expect(sanitizeBufferStart(complete)).toBe(complete);
    });

    it("treats ESC+[ as complete via regex fallback", () => {
      expect(sanitizeBufferStart("\x1b[hello")).toBe("\x1b[hello");
    });

    it("keeps ESC+char (fallback matches any single char after ESC)", () => {
      expect(sanitizeBufferStart("\x1bhello")).toBe("\x1bhello");
    });

    it("treats unterminated OSC as complete (fallback matches ESC+])", () => {
      const partial = "\x1b]unterminated title";
      const complete = "\x1b[32mtext";
      expect(sanitizeBufferStart(partial + complete)).toBe(partial + complete);
    });
  });

  describe("screen clear (\\x1b[2J) near start", () => {
    it("trims to screen clear within scan limit", () => {
      const prefix = "some garbage output";
      const rest = "\x1b[2Jclean screen content";
      const result = sanitizeBufferStart(prefix + rest);
      expect(result).toBe(rest);
    });

    it("trims to screen clear after UTF-8 cleanup", () => {
      const cont = String.fromCharCode(0x80, 0x90);
      const rest = "\x1b[2Jclean content";
      const result = sanitizeBufferStart(cont + "junk" + rest);
      expect(result).toBe(rest);
    });
  });

  describe("alt screen (\\x1b[?1049h) near start", () => {
    it("trims to alt screen within scan limit", () => {
      const prefix = "some output before alt";
      const rest = "\x1b[?1049hTUI content";
      const result = sanitizeBufferStart(prefix + rest);
      expect(result).toBe(rest);
    });
  });

  describe("both reset sequences present", () => {
    it("trims to the earlier one (screen clear first)", () => {
      const prefix = "junk";
      const clear = "\x1b[2Jclear";
      const alt = "\x1b[?1049halt";
      const result = sanitizeBufferStart(prefix + clear + alt);
      expect(result).toBe(clear + alt);
    });

    it("trims to the earlier one (alt screen first)", () => {
      const prefix = "junk";
      const alt = "\x1b[?1049halt";
      const clear = "\x1b[2Jclear";
      const result = sanitizeBufferStart(prefix + alt + clear);
      expect(result).toBe(alt + clear);
    });
  });

  describe("no reset sequence", () => {
    it("returns cleaned buffer without further trimming", () => {
      const text = "normal output with \x1b[32mcolors\x1b[0m and stuff";
      expect(sanitizeBufferStart(text)).toBe(text);
    });

    it("still strips leading continuation bytes", () => {
      const cont = String.fromCharCode(0x80);
      const text = "normal text after bad byte";
      expect(sanitizeBufferStart(cont + text)).toBe(text);
    });
  });

  describe("reset sequence beyond 25% scan limit", () => {
    it("does not trim to reset beyond the scan window", () => {
      // Build a buffer where the reset is past RESET_SCAN_LIMIT
      const padding = "x".repeat(RESET_SCAN_LIMIT + 100);
      const reset = "\x1b[2Jlate reset";
      const buf = padding + reset;
      const result = sanitizeBufferStart(buf);
      // Should return full buffer since no reset within scan window
      expect(result).toBe(buf);
    });

    it("trims to reset just inside the scan window", () => {
      // Place reset right before the limit
      const paddingLen = RESET_SCAN_LIMIT - 10;
      const padding = "x".repeat(paddingLen);
      const reset = "\x1b[2Jcontent after reset";
      const buf = padding + reset;
      const result = sanitizeBufferStart(buf);
      expect(result).toBe(reset);
    });
  });

  describe("normal shell output passthrough", () => {
    it("passes through plain text unchanged", () => {
      const text = "$ ls\nfile1.txt\nfile2.txt\n";
      expect(sanitizeBufferStart(text)).toBe(text);
    });

    it("passes through text with ANSI colors unchanged", () => {
      const text = "\x1b[1;34mdir/\x1b[0m  \x1b[32mfile.js\x1b[0m\n$ ";
      expect(sanitizeBufferStart(text)).toBe(text);
    });

    it("passes through prompt with cursor movement unchanged", () => {
      const text = "\x1b[?2004h$ \x1b[?2004l\n";
      expect(sanitizeBufferStart(text)).toBe(text);
    });
  });
});
