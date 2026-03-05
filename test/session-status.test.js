import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { isTranscriptNewerThanSignal } from "../src/session-status";

const TMP = path.join(os.tmpdir(), "session-status-test");

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function mtimeMs(filePath) {
  return fs.statSync(filePath).mtimeMs;
}

describe("isTranscriptNewerThanSignal", () => {
  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("returns false when transcript was written before signal (normal idle)", () => {
    const transcript = path.join(TMP, "transcript.jsonl");
    const signal = path.join(TMP, "signal.json");
    fs.writeFileSync(transcript, '{"type":"assistant"}');
    sleep(10);
    fs.writeFileSync(signal, '{"ts":1234}');
    expect(isTranscriptNewerThanSignal(mtimeMs(signal), transcript)).toBe(
      false,
    );
  });

  it("returns true when transcript was written well after signal (re-prompt)", () => {
    const transcript = path.join(TMP, "transcript.jsonl");
    const signal = path.join(TMP, "signal.json");
    fs.writeFileSync(signal, '{"ts":1234}');
    // Simulate a re-prompt that happens >5s after the idle signal
    const signalMtime = mtimeMs(signal) - 6000; // pretend signal was 6s ago
    fs.writeFileSync(transcript, '{"type":"assistant"}');
    expect(isTranscriptNewerThanSignal(signalMtime, transcript)).toBe(true);
  });

  it("returns false when transcript trails signal by <5s (normal flush)", () => {
    const transcript = path.join(TMP, "transcript.jsonl");
    const signal = path.join(TMP, "signal.json");
    fs.writeFileSync(signal, '{"ts":1234}');
    sleep(10);
    fs.writeFileSync(transcript, '{"type":"assistant"}');
    // Within tolerance — should NOT be treated as re-prompt
    expect(isTranscriptNewerThanSignal(mtimeMs(signal), transcript)).toBe(
      false,
    );
  });

  it("returns true when transcript is appended well after signal (mid-session re-prompt)", () => {
    const transcript = path.join(TMP, "transcript.jsonl");
    const signal = path.join(TMP, "signal.json");
    fs.writeFileSync(transcript, '{"type":"assistant","msg":"first"}\n');
    sleep(10);
    fs.writeFileSync(signal, '{"ts":1234}');
    // Simulate signal being old enough that tolerance is exceeded
    const signalMtime = mtimeMs(signal) - 6000;
    fs.appendFileSync(transcript, '{"type":"assistant","msg":"reprompt"}\n');
    expect(isTranscriptNewerThanSignal(signalMtime, transcript)).toBe(true);
  });

  it("returns false for empty transcript path", () => {
    expect(isTranscriptNewerThanSignal(Date.now(), "")).toBe(false);
  });

  it("returns false for null/undefined transcript path", () => {
    expect(isTranscriptNewerThanSignal(Date.now(), null)).toBe(false);
    expect(isTranscriptNewerThanSignal(Date.now(), undefined)).toBe(false);
  });

  it("returns false for null/undefined/zero signalMtimeMs", () => {
    const transcript = path.join(TMP, "transcript.jsonl");
    fs.writeFileSync(transcript, "data");
    expect(isTranscriptNewerThanSignal(null, transcript)).toBe(false);
    expect(isTranscriptNewerThanSignal(undefined, transcript)).toBe(false);
    expect(isTranscriptNewerThanSignal(0, transcript)).toBe(false);
  });

  it("returns false when transcript file does not exist", () => {
    expect(
      isTranscriptNewerThanSignal(
        Date.now(),
        path.join(TMP, "nonexistent.jsonl"),
      ),
    ).toBe(false);
  });

  it("returns false when signal is rewritten after re-prompt response completes", () => {
    const transcript = path.join(TMP, "transcript.jsonl");
    const signal = path.join(TMP, "signal.json");
    fs.writeFileSync(
      transcript,
      '{"type":"assistant","msg":"reprompt response"}',
    );
    sleep(10);
    fs.writeFileSync(signal, '{"ts":9999}');
    expect(isTranscriptNewerThanSignal(mtimeMs(signal), transcript)).toBe(
      false,
    );
  });

  it("treats near-simultaneous writes as normal flush (within tolerance)", () => {
    const transcript = path.join(TMP, "transcript.jsonl");
    const signal = path.join(TMP, "signal.json");
    fs.writeFileSync(signal, "x");
    const signalMtime = mtimeMs(signal);
    fs.writeFileSync(transcript, "y");
    // Near-simultaneous writes are within the 5s tolerance — not a re-prompt
    expect(isTranscriptNewerThanSignal(signalMtime, transcript)).toBe(false);
  });
});
