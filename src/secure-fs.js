// Secure file helpers — restrict to owner-only access (#210)
const fs = require("fs");

function secureMkdirSync(dirPath, opts = {}) {
  fs.mkdirSync(dirPath, { ...opts, mode: 0o700 });
}

function secureWriteFileSync(filePath, data, opts) {
  fs.writeFileSync(filePath, data, { ...opts, mode: 0o600 });
}

module.exports = { secureMkdirSync, secureWriteFileSync };
