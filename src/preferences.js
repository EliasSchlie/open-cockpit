const { readJsonSync, secureWriteFileSync } = require("./secure-fs");
const { PREFERENCES_FILE } = require("./paths");

function getPreference(key, fallback) {
  const prefs = readJsonSync(PREFERENCES_FILE, {});
  return key in prefs ? prefs[key] : fallback;
}

function setPreference(key, value) {
  const prefs = readJsonSync(PREFERENCES_FILE, {});
  prefs[key] = value;
  secureWriteFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
}

module.exports = { getPreference, setPreference };
