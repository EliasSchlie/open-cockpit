const fs = require("fs");

// Check if the JSONL transcript was modified after the idle signal was written.
// This detects re-prompts from blocking Stop hooks: the idle signal exists but
// Claude is still processing because another hook re-prompted it.
// Uses pre-fetched signal mtime (from getIdleSignal) to avoid redundant stat calls.
// Tolerance for transcript writes that trail the idle signal by a few seconds
// (e.g., Claude flushing the final response to the JSONL after the stop hook fires).
// A real re-prompt causes writes many seconds later, well beyond this margin.
const TRANSCRIPT_TOLERANCE_MS = 5000;

function isTranscriptNewerThanSignal(signalMtimeMs, transcriptPath) {
  if (!transcriptPath || !signalMtimeMs) return false;
  try {
    const transcriptMtime = fs.statSync(transcriptPath).mtimeMs;
    return transcriptMtime > signalMtimeMs + TRANSCRIPT_TOLERANCE_MS;
  } catch {
    return false;
  }
}

module.exports = { isTranscriptNewerThanSignal };
