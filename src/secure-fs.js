// Secure file helpers — restrict to owner-only access (#210)
// On Windows, mode is ignored (ACLs handle permissions).
const fs = require("fs");
const { IS_WINDOWS } = require("./platform");

function secureMkdirSync(dirPath, opts = {}) {
  fs.mkdirSync(dirPath, { ...opts, ...(IS_WINDOWS ? {} : { mode: 0o700 }) });
}

function secureWriteFileSync(filePath, data, opts) {
  fs.writeFileSync(filePath, data, {
    ...opts,
    ...(IS_WINDOWS ? {} : { mode: 0o600 }),
  });
}

module.exports = { secureMkdirSync, secureWriteFileSync };
