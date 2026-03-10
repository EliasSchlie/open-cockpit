const fs = require("fs");
const { ACTIVE_SESSIONS_FILE } = require("./paths");
const { secureWriteFileSync, readJsonSync } = require("./secure-fs");
const { POOL_STATUS } = require("./session-statuses");

const ACTIVE_STATUSES = new Set([
  POOL_STATUS.BUSY,
  POOL_STATUS.IDLE,
  POOL_STATUS.TYPING,
]);

function readActiveRegistry() {
  return readJsonSync(ACTIVE_SESSIONS_FILE, {});
}

function writeActiveRegistry(registry) {
  secureWriteFileSync(ACTIVE_SESSIONS_FILE, JSON.stringify(registry, null, 2));
}

function registerActiveSession(sessionId, claudeSessionId) {
  const registry = readActiveRegistry();
  registry[sessionId] = { claudeSessionId: claudeSessionId || sessionId };
  writeActiveRegistry(registry);
}

function unregisterActiveSession(sessionId) {
  const registry = readActiveRegistry();
  if (!(sessionId in registry)) return;
  delete registry[sessionId];
  writeActiveRegistry(registry);
}

function getSessionsToRestore(liveSessionIds) {
  const registry = readActiveRegistry();
  const toRestore = [];
  for (const [sessionId, entry] of Object.entries(registry)) {
    if (!liveSessionIds.has(sessionId)) {
      toRestore.push({ sessionId, claudeSessionId: entry.claudeSessionId });
    }
  }
  return toRestore;
}

function syncRegistryWithPool(slots) {
  const registry = {};
  for (const slot of slots) {
    if (!slot.sessionId) continue;
    if (!ACTIVE_STATUSES.has(slot.status)) continue;
    registry[slot.sessionId] = {
      claudeSessionId: slot.sessionId,
    };
  }
  writeActiveRegistry(registry);
}

module.exports = {
  readActiveRegistry,
  registerActiveSession,
  unregisterActiveSession,
  getSessionsToRestore,
  syncRegistryWithPool,
};
