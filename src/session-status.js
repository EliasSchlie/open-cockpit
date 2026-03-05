const fs = require("fs");

// Check if the JSONL transcript was modified after the idle signal was written.
// This detects re-prompts from blocking Stop hooks: the idle signal exists but
// Claude is still processing because another hook re-prompted it.
// Uses pre-fetched signal mtime (from getIdleSignal) to avoid redundant stat calls.
function isTranscriptNewerThanSignal(signalMtimeMs, transcriptPath) {
  if (!transcriptPath || !signalMtimeMs) return false;
  try {
    const transcriptMtime = fs.statSync(transcriptPath).mtimeMs;
    return transcriptMtime > signalMtimeMs;
  } catch {
    return false;
  }
}

module.exports = { isTranscriptNewerThanSignal };
