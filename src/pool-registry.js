/**
 * Pool registry: manages connections to multiple claude-pool daemons.
 *
 * Each pool has a name (e.g., "default", "fast-tasks") and its own
 * ClaudePoolClient. Sessions are tagged with pool name for routing.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ClaudePoolClient, CLAUDE_POOL_HOME } = require("./claude-pool-client");
const { readJsonSync } = require("./secure-fs");

const POOLS_REGISTRY = path.join(CLAUDE_POOL_HOME, "pools.json");

/** @type {Map<string, ClaudePoolClient>} */
const _clients = new Map();

let _debugLog = () => {};
let _onEvent = () => {};

/**
 * Initialize the registry. Connects to all pools found in pools.json.
 * @param {{ debugLog: Function, onEvent: Function }} opts
 */
async function init({ debugLog, onEvent }) {
  if (debugLog) _debugLog = debugLog;
  if (onEvent) _onEvent = onEvent;

  const registry = readJsonSync(POOLS_REGISTRY, {});
  const names = Object.keys(registry);
  _debugLog(
    "pool-registry",
    `found ${names.length} pool(s): ${names.join(", ") || "(none)"}`,
  );

  for (const name of names) {
    await connectPool(name);
  }
}

/**
 * Connect to a pool by name. Creates a client and tries to connect.
 * Non-fatal: logs and continues if pool daemon isn't running.
 */
async function connectPool(name) {
  if (_clients.has(name)) return _clients.get(name);

  const client = new ClaudePoolClient({
    poolName: name,
    debugLog: _debugLog,
    onEvent: (msg) => _onEvent(name, msg),
  });

  _clients.set(name, client);

  try {
    await client.connect();
    _debugLog("pool-registry", `connected to pool '${name}'`);
    client.subscribe({ events: ["created", "status", "updated"] });
    return client;
  } catch (err) {
    _debugLog("pool-registry", `pool '${name}' not running: ${err.message}`);
    return client;
  }
}

/**
 * Add and initialize a new pool.
 * @param {string} name - Pool name
 * @param {{ size?: number, flags?: string }} opts
 */
async function addPool(name, { size, flags } = {}) {
  if (!name || typeof name !== "string") throw new Error("pool name required");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("pool name must be alphanumeric (hyphens/underscores ok)");
  }

  const client = await connectPool(name);
  const resp = await client.init(size, flags);
  _debugLog("pool-registry", `pool '${name}' initialized`);
  return resp;
}

/**
 * Destroy a pool and disconnect.
 * @param {string} name - Pool name
 */
async function removePool(name) {
  const client = _clients.get(name);
  if (!client) throw new Error(`pool '${name}' not found`);

  if (client.isConnected()) {
    try {
      await client.destroyPool();
    } catch (err) {
      _debugLog(
        "pool-registry",
        `destroy failed for '${name}': ${err.message}`,
      );
    }
  }

  client.destroy();
  _clients.delete(name);
  _debugLog("pool-registry", `pool '${name}' removed`);
}

/**
 * Get a pool client by name. Returns null if not found.
 * @param {string} name
 * @returns {ClaudePoolClient | null}
 */
function getClient(name) {
  return _clients.get(name) || null;
}

/**
 * Get the first connected client (for backward-compat with single-pool code).
 * @returns {ClaudePoolClient | null}
 */
function getDefaultClient() {
  // Prefer "default" pool
  const def = _clients.get("default");
  if (def && def.isConnected()) return def;
  // Fall back to first connected
  for (const [, client] of _clients) {
    if (client.isConnected()) return client;
  }
  return def || null;
}

/**
 * Get all pool names and their connection status.
 * @returns {Array<{ name: string, connected: boolean }>}
 */
function listPools() {
  const result = [];
  // Include pools from registry even if not connected
  const registry = readJsonSync(POOLS_REGISTRY, {});
  const allNames = new Set([...Object.keys(registry), ..._clients.keys()]);

  for (const name of allNames) {
    const client = _clients.get(name);
    result.push({
      name,
      connected: client ? client.isConnected() : false,
    });
  }
  return result;
}

/**
 * Get all connected clients.
 * @returns {Map<string, ClaudePoolClient>}
 */
function getConnectedClients() {
  const result = new Map();
  for (const [name, client] of _clients) {
    if (client.isConnected()) result.set(name, client);
  }
  return result;
}

/**
 * Find which pool owns a session by querying all connected pools.
 * Returns { poolName, client } or null.
 * Results are cached per session ID.
 */
const _sessionPoolCache = new Map();

async function findPoolForSession(sessionId) {
  if (_sessionPoolCache.has(sessionId)) {
    const cached = _sessionPoolCache.get(sessionId);
    const client = _clients.get(cached);
    if (client && client.isConnected()) return { poolName: cached, client };
    _sessionPoolCache.delete(sessionId);
  }

  for (const [name, client] of _clients) {
    if (!client.isConnected()) continue;
    try {
      const resp = await client.info(sessionId);
      if (resp && resp.sessionId) {
        _sessionPoolCache.set(sessionId, name);
        return { poolName: name, client };
      }
    } catch {
      // Session not in this pool
    }
  }
  return null;
}

/**
 * Get a client for a session, or throw.
 */
async function requireClientForSession(sessionId) {
  const result = await findPoolForSession(sessionId);
  if (!result) throw new Error(`session ${sessionId} not found in any pool`);
  return result;
}

/**
 * Invalidate session-pool cache entry (e.g., after archive).
 */
function invalidateSessionCache(sessionId) {
  _sessionPoolCache.delete(sessionId);
}

/**
 * Clean up all clients on shutdown.
 */
function destroyAll() {
  for (const [, client] of _clients) {
    client.destroy();
  }
  _clients.clear();
  _sessionPoolCache.clear();
}

module.exports = {
  init,
  connectPool,
  addPool,
  removePool,
  getClient,
  getDefaultClient,
  listPools,
  getConnectedClients,
  findPoolForSession,
  requireClientForSession,
  invalidateSessionCache,
  destroyAll,
};
