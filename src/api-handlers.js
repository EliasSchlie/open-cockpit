const os = require("os");
const path = require("path");
const fs = require("fs");
const { AGENTS_DIR } = require("./paths");

/** Split a shell-like args string into an array, respecting quotes. */
function splitArgs(str) {
  if (!str) return [];
  return (str.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((a) =>
    a.replace(/^["']|["']$/g, ""),
  );
}

const { STATUS, POOL_STATUS, INITIATOR } = require("./session-statuses");
const {
  daemonRequest,
  daemonSendSafe,
  ensureDaemon,
} = require("./daemon-client");
const {
  getSessions,
  findJsonlPath,
  getCwdFromJsonl,
  triggerPollOnWrite,
} = require("./session-discovery");
const {
  stripAnsi,
  validateSessionId,
  validateTermId,
  readSessionGraph,
  recordSessionRelation,
  enrichSessionsWithGraphData,
  archiveSession,
  unarchiveSession,
  poolInit,
  poolResize,
  getPoolHealth,
  poolDestroy,
  poolClean,
  getPoolFlags,
  setPoolFlags,
  getMinFreshSlots,
  setMinFreshSlots,
  poolResume,
  readIntention,
  writeIntention,
  getCachedClaudePath,
} = require("./pool-manager");

let _getMainWindow = () => null;
let _onSessionArchived = null;

/** @type {import('./claude-pool-client').ClaudePoolClient | null} */
let _poolClient = null;

function init({ getMainWindow, claudePoolClient, onSessionArchived }) {
  _getMainWindow = getMainWindow;
  if (claudePoolClient) _poolClient = claudePoolClient;
  if (onSessionArchived) _onSessionArchived = onSessionArchived;
}

/** Get main window or throw if unavailable. */
function _requireMainWindow() {
  const win = _getMainWindow();
  if (!win || win.isDestroyed()) throw new Error("No window");
  return win;
}

/** Require pool client or throw. */
function _requirePoolClient() {
  if (!_poolClient || !_poolClient.isConnected()) {
    throw new Error("claude-pool not connected");
  }
  return _poolClient;
}

// --- Session terminal helpers (using claude-term via daemon-client) ---

async function getSessionTerminals(sessionId) {
  validateSessionId(sessionId);
  const resp = await daemonRequest({ type: "list" });
  const terms = resp.ptys
    .filter((p) => p.owner === sessionId && !p.exited)
    .sort((a, b) => (a.term_id || a.termId) - (b.term_id || b.termId));

  let shellCount = 0;
  return terms.map((p, i) => {
    shellCount++;
    const termId = p.term_id ?? p.termId;
    return {
      termId,
      index: i,
      label: `Shell ${shellCount}`,
      pid: p.pid,
      cwd: p.cwd,
    };
  });
}

// --- Shared handler registry (serves both IPC and API) ---
// Each handler takes a params object and returns raw data.
// IPC adapter: converts positional args -> params, returns raw result.
// API adapter: passes msg as params, wraps result with { type, ... }.

const sharedHandlers = {
  "get-sessions": async () => {
    const sessions = await getSessions();
    // Pool status enrichment via claude-pool (if connected)
    if (_poolClient && _poolClient.isConnected()) {
      try {
        const poolSessions = await _poolClient.ls({ verbosity: "flat" });
        const poolMap = new Map(
          (poolSessions.sessions || []).map((s) => [s.sessionId, s]),
        );
        for (const s of sessions) {
          const ps = poolMap.get(s.sessionId);
          if (ps) {
            s.poolStatus = ps.status;
            if (ps.pinned) s.pinnedUntil = ps.pinned;
          }
        }
      } catch {
        /* pool not running */
      }
    }
    enrichSessionsWithGraphData(sessions);
    return sessions;
  },
  "read-intention": ({ sessionId }) => {
    validateSessionId(sessionId);
    return readIntention(sessionId);
  },
  "write-intention": ({ sessionId, content }) => {
    validateSessionId(sessionId);
    return writeIntention(sessionId, content);
  },
  "pty-spawn": async ({ cwd, cmd, args, sessionId }) => {
    const resp = await daemonRequest({
      type: "spawn",
      cwd,
      cmd,
      args,
      sessionId,
    });
    return { termId: resp.termId ?? resp.term_id, pid: resp.pid };
  },
  "pty-write": async ({ termId, data }) => {
    validateTermId(termId);
    await ensureDaemon();
    daemonSendSafe({ type: "write", termId, data });
    triggerPollOnWrite(termId);
  },
  "pty-list": async () => {
    const resp = await daemonRequest({ type: "list" });
    return resp.ptys;
  },
  "pty-kill": async ({ termId }) => {
    validateTermId(termId);
    await daemonRequest({ type: "kill", termId });
  },
  "pool-init": async ({ size }) => poolInit(size),
  "pool-resize": async ({ size }) => poolResize(size),
  "pool-read": async () => {
    // Return pool data compatible with the old pool.json structure.
    // Uses debug-slots for accurate per-slot data (index, pid, sessionId, state).
    if (!_poolClient || !_poolClient.isConnected()) return null;
    try {
      const resp = await _poolClient.debugSlots();
      const rawSlots = resp.slots || [];
      const slots = rawSlots.map((s) => ({
        index: s.index,
        sessionId: s.sessionId || null,
        status: s.state || "unknown",
        pid: s.pid || null,
        // In the new model, termId = sessionId for pool sessions
        termId: s.sessionId || null,
      }));
      return { poolSize: slots.length, slots };
    } catch {
      return null;
    }
  },
  "pool-health": async () => getPoolHealth(),
  "pool-destroy": async () => poolDestroy(),
  "pool-clean": async () => poolClean(),
  "pool-get-flags": async () => getPoolFlags(),
  "pool-set-flags": async ({ flags }) => {
    await setPoolFlags(flags);
    return flags;
  },
  "pool-get-min-fresh": async () => getMinFreshSlots(),
  "pool-set-min-fresh": async ({ minFreshSlots }) => {
    await setMinFreshSlots(minFreshSlots);
    return minFreshSlots;
  },
  "pool-resume": async ({ sessionId }) => poolResume(sessionId),
  "archive-session": async ({ sessionId }) => {
    await archiveSession(sessionId);
    if (_onSessionArchived) _onSessionArchived(sessionId);
  },
  "unarchive-session": ({ sessionId }) => unarchiveSession(sessionId),
  "list-agents": async ({ cwd }) => {
    const agents = new Map(); // name -> { name, path, description, scope, args }

    function parseAgentFile(filePath) {
      let description = "";
      const args = [];
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const descMatch = content.match(/^# Description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim();
        const argRe = /^# Arg:\s*(.+)$/gm;
        let m;
        while ((m = argRe.exec(content)) !== null) {
          const parts = m[1].split("|").map((s) => s.trim());
          const arg = { name: parts[0] };
          if (parts[1]) arg.description = parts[1];
          if (parts.includes("optional")) arg.required = false;
          else arg.required = true;
          const defPart = parts.find((p) => p.startsWith("default:"));
          if (defPart) arg.default = defPart.slice(8).trim();
          args.push(arg);
        }
      } catch {
        /* ignore read errors */
      }
      return { description, args };
    }

    function scanDir(dir, scope) {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (!entry.endsWith(".sh")) continue;
          const name = entry.slice(0, -3);
          const filePath = path.join(dir, entry);
          try {
            if (!fs.statSync(filePath).isFile()) continue;
          } catch {
            continue;
          }
          const { description, args } = parseAgentFile(filePath);
          agents.set(name, { name, path: filePath, description, scope, args });
        }
      } catch {
        /* directory doesn't exist, skip */
      }
    }

    scanDir(AGENTS_DIR, "global");
    if (cwd) {
      scanDir(path.join(cwd, ".open-cockpit", "agents"), "local");
    }

    return Array.from(agents.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  },
  "spawn-custom-session": async ({ cwd, flags }) => {
    const claudePath = getCachedClaudePath();
    const args = ["--dangerously-skip-permissions"];
    if (flags) {
      args.push(...splitArgs(flags));
    }
    // Expand ~ to home directory
    let resolvedCwd = cwd || "~";
    if (resolvedCwd.startsWith("~")) {
      resolvedCwd = path.join(os.homedir(), resolvedCwd.slice(1));
    }
    const resp = await daemonRequest({
      type: "spawn",
      cwd: resolvedCwd,
      cmd: claudePath,
      args,
      env: { OPEN_COCKPIT_CUSTOM: "1" },
    });
    return { termId: resp.termId ?? resp.term_id, pid: resp.pid };
  },
};

// IPC arg mappers: convert positional ipcMain.handle args -> params object
const ipcArgMap = {
  "get-sessions": () => ({}),
  "read-intention": (sessionId) => ({ sessionId }),
  "write-intention": (sessionId, content) => ({ sessionId, content }),
  "pty-spawn": (opts) => opts,
  "pty-write": (termId, data) => ({ termId, data }),
  "pty-list": () => ({}),
  "pty-kill": (termId) => ({ termId }),
  "pool-init": (size) => ({ size }),
  "pool-resize": (size) => ({ size }),
  "pool-read": () => ({}),
  "pool-health": () => ({}),
  "pool-destroy": () => ({}),
  "pool-clean": () => ({}),
  "pool-get-flags": () => ({}),
  "pool-set-flags": (flags) => ({ flags }),
  "pool-get-min-fresh": () => ({}),
  "pool-set-min-fresh": (minFreshSlots) => ({ minFreshSlots }),
  "pool-resume": (sessionId) => ({ sessionId }),
  "archive-session": (sessionId) => ({ sessionId }),
  "unarchive-session": (sessionId) => ({ sessionId }),
  "spawn-custom-session": (cwd, flags) => ({ cwd, flags }),
  "list-agents": (cwd) => ({ cwd }),
};

// API response wrappers: transform raw handler results into API protocol
const apiResponseMap = {
  "get-sessions": (sessions) => ({ type: "sessions", sessions }),
  "read-intention": (content) => ({ type: "intention", content }),
  "write-intention": () => ({ type: "ok" }),
  "pty-spawn": (result) => ({ type: "spawned", ...result }),
  "pty-write": () => ({ type: "ok" }),
  "pty-list": (ptys) => ({ type: "ptys", ptys }),
  "pty-kill": () => ({ type: "ok" }),
  "pool-init": (pool) => ({ type: "pool", pool }),
  "pool-resize": (pool) => ({ type: "pool", pool }),
  "pool-read": (pool) => ({ type: "pool", pool }),
  "pool-health": (health) => ({ type: "health", health }),
  "pool-destroy": () => ({ type: "ok" }),
  "pool-clean": (cleaned) => ({ type: "cleaned", count: cleaned }),
  "pool-get-flags": (flags) => ({ type: "flags", flags }),
  "pool-set-flags": (flags) => ({ type: "flags", flags }),
  "pool-get-min-fresh": (n) => ({ type: "min-fresh", minFreshSlots: n }),
  "pool-set-min-fresh": (n) => ({ type: "min-fresh", minFreshSlots: n }),
  "pool-resume": (result) => result, // poolResume already returns { type: "resumed", ... }
  "archive-session": () => ({ type: "ok" }),
  "unarchive-session": () => ({ type: "ok" }),
  "spawn-custom-session": (result) => ({ type: "spawned", ...result }),
  "list-agents": (agents) => ({ type: "agents", agents }),
};

// Build the complete API handler map (shared + API-only)
function buildApiHandlers() {
  const handlers = {};

  // Wrap shared handlers with response wrappers
  for (const [name, wrapper] of Object.entries(apiResponseMap)) {
    handlers[name] = async (msg) => wrapper(await sharedHandlers[name](msg));
  }

  // --- API-only handlers ---

  handlers["ping"] = async () => ({ type: "pong" });

  handlers["relaunch"] = async () => {
    const { execSync } = require("child_process");
    const path = require("path");
    try {
      execSync("npm run build", {
        cwd: path.join(__dirname, ".."),
        stdio: "ignore",
        timeout: 30000,
      });
    } catch (err) {
      return { type: "error", error: "Build failed: " + err.message };
    }
    // Delay to let the response reach the client before exit
    const { app } = require("electron");
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 100);
    return { type: "ok", message: "Relaunching..." };
  };

  // --- Window visibility (Phase 3: Hidden Dev Mode) ---
  handlers["show"] = async () => {
    _requireMainWindow().show();
    return { type: "ok" };
  };

  handlers["hide"] = async () => {
    _requireMainWindow().hide();
    return { type: "ok" };
  };

  // --- Remote control (Phase 5) ---
  handlers["screenshot"] = async () => {
    const win = _requireMainWindow();
    // Hidden windows that were never shown don't paint the DOM.
    // Move off-screen, show briefly to force a paint, then re-hide.
    const wasVisible = win.isVisible();
    if (!wasVisible) {
      const pos = win.getPosition();
      win.setPosition(-9999, -9999);
      win.showInactive();
      await new Promise((r) => setTimeout(r, 200));
      const image = await win.webContents.capturePage();
      win.hide();
      win.setPosition(pos[0], pos[1]);
      return { type: "screenshot", image: image.toPNG().toString("base64") };
    }
    const image = await win.webContents.capturePage();
    return { type: "screenshot", image: image.toPNG().toString("base64") };
  };

  handlers["ui-state"] = async () => {
    const win = _requireMainWindow();
    const uiState = await win.webContents.executeJavaScript(
      `window.__getUiState ? window.__getUiState() : null`,
    );
    if (!uiState)
      throw new Error("UI state not available (renderer not ready)");
    return { type: "ui-state", ...uiState };
  };

  handlers["session-select"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    _requireMainWindow().webContents.send("api-session-select", msg.sessionId);
    return { type: "ok" };
  };

  // --- PTY read (via claude-term) ---

  handlers["pty-read"] = async (msg) => {
    validateTermId(msg.termId);
    const resp = await daemonRequest({
      type: "read-buffer",
      term_id: msg.termId,
    });
    return { type: "buffer", buffer: resp.buffer || "" };
  };

  // --- Pool interaction (via claude-pool) ---

  handlers["pool-start"] = async (msg) => {
    if (!msg.prompt) throw new Error("prompt required");
    const client = _requirePoolClient();
    const resp = await client.start({
      prompt: msg.prompt,
      parent: msg.parentSessionId,
    });
    recordSessionRelation(
      resp.sessionId,
      msg.parentSessionId || null,
      msg.parentSessionId ? INITIATOR.MODEL : INITIATOR.USER,
    );
    return { type: "started", sessionId: resp.sessionId };
  };

  handlers["pool-followup"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (!msg.prompt) throw new Error("prompt required");
    const client = _requirePoolClient();
    await client.followup(msg.sessionId, msg.prompt);
    return { type: "started", sessionId: msg.sessionId };
  };

  handlers["pool-wait"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    validateSessionId(msg.sessionId);
    const client = _requirePoolClient();
    const timeout = msg.timeout || 300000;
    const resp = await client.wait(msg.sessionId, {
      timeout,
      source: "buffer",
    });
    return {
      type: "result",
      sessionId: msg.sessionId,
      buffer: resp.content || "",
    };
  };

  handlers["pool-capture"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const client = _requirePoolClient();
    const resp = await client.capture(msg.sessionId, { source: "buffer" });
    return {
      type: "buffer",
      sessionId: msg.sessionId,
      buffer: resp.content || "",
    };
  };

  handlers["pool-input"] = async (msg) => {
    if (msg.data === undefined) throw new Error("data required");
    if (!msg.sessionId) throw new Error("sessionId required");
    const client = _requirePoolClient();
    await client.input(msg.sessionId, msg.data);
    return { type: "ok" };
  };

  handlers["pool-pin"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const client = _requirePoolClient();
    await client.set(msg.sessionId, { pinned: msg.duration || 120 });
    return { type: "ok" };
  };

  handlers["pool-unpin"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const client = _requirePoolClient();
    await client.set(msg.sessionId, { pinned: false });
    return { type: "ok" };
  };

  handlers["pool-stop-session"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const client = _requirePoolClient();
    await client.stop(msg.sessionId);
    return { type: "ok", sessionId: msg.sessionId };
  };

  handlers["get-session-graph"] = async () => ({
    type: "session-graph",
    graph: readSessionGraph(),
  });

  // --- Slot access (via claude-pool debug-slots) ---

  handlers["slot-status"] = async (msg) => {
    if (msg.slotIndex === undefined) throw new Error("slotIndex required");
    const client = _requirePoolClient();
    const resp = await client.debugSlots();
    const slot = (resp.slots || []).find((s) => s.index === msg.slotIndex);
    if (!slot) throw new Error(`No slot at index ${msg.slotIndex}`);
    return {
      type: "slot",
      slot: {
        index: slot.index,
        pid: slot.pid,
        status: slot.state,
        sessionId: slot.sessionId || null,
        healthStatus: slot.state,
      },
    };
  };

  handlers["slot-read"] = async (msg) => {
    if (msg.slotIndex === undefined) throw new Error("slotIndex required");
    const client = _requirePoolClient();
    const resp = await client.debugCapture(msg.slotIndex);
    return {
      type: "buffer",
      slotIndex: msg.slotIndex,
      buffer: resp.content || "",
    };
  };

  handlers["slot-write"] = async (msg) => {
    if (msg.slotIndex === undefined) throw new Error("slotIndex required");
    if (msg.data === undefined) throw new Error("data required");
    const client = _requirePoolClient();
    // Find the session in the slot to send input
    const slotsResp = await client.debugSlots();
    const slot = (slotsResp.slots || []).find((s) => s.index === msg.slotIndex);
    if (!slot?.sessionId)
      throw new Error(`Slot ${msg.slotIndex} has no session`);
    await client.input(slot.sessionId, msg.data);
    return { type: "ok" };
  };

  // --- Session terminals (via claude-term) ---

  handlers["session-terminals"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const terminals = await getSessionTerminals(msg.sessionId);
    return { type: "terminals", terminals };
  };

  handlers["session-term-read"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (msg.tabIndex === undefined) throw new Error("tabIndex required");
    const terminals = await getSessionTerminals(msg.sessionId);
    const tab = terminals[msg.tabIndex];
    if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
    const resp = await daemonRequest({
      type: "read-buffer",
      term_id: tab.termId,
    });
    return { type: "buffer", termId: tab.termId, buffer: resp.buffer || "" };
  };

  handlers["session-term-write"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (msg.tabIndex === undefined) throw new Error("tabIndex required");
    if (msg.data === undefined) throw new Error("data required");
    const terminals = await getSessionTerminals(msg.sessionId);
    const tab = terminals[msg.tabIndex];
    if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
    daemonSendSafe({ type: "write", term_id: tab.termId, data: msg.data });
    return { type: "ok" };
  };

  handlers["session-term-open"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    validateSessionId(msg.sessionId);
    let cwd = msg.cwd;
    if (!cwd) {
      const existing = await getSessionTerminals(msg.sessionId);
      if (existing.length > 0) cwd = existing[0].cwd;
    }
    const resp = await daemonRequest({
      type: "spawn",
      cwd: cwd || os.homedir(),
      owner: msg.sessionId,
    });
    const termId = resp.termId ?? resp.term_id;
    const terminals = await getSessionTerminals(msg.sessionId);
    const newTab = terminals.find((t) => t.termId === termId);
    const mainWindow = _getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("api-term-opened", msg.sessionId, termId);
    }
    return {
      type: "spawned",
      termId,
      tabIndex: newTab ? newTab.index : terminals.length - 1,
    };
  };

  handlers["session-term-run"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (msg.tabIndex === undefined) throw new Error("tabIndex required");
    if (!msg.command) throw new Error("command required");
    const timeoutMs = msg.timeout || 30000;
    const terminals = await getSessionTerminals(msg.sessionId);
    const tab = terminals[msg.tabIndex];
    if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
    // Read current buffer before sending command
    const beforeResp = await daemonRequest({
      type: "read-buffer",
      term_id: tab.termId,
    });
    const beforeBuffer = beforeResp.buffer || "";
    daemonSendSafe({
      type: "write",
      term_id: tab.termId,
      data: msg.command + "\r",
    });
    const promptRe = /[\$\u276F%#>] *$/;
    const deadline = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() < deadline) {
      const bufResp = await daemonRequest({
        type: "read-buffer",
        term_id: tab.termId,
      });
      const buf = bufResp.buffer || "";
      if (buf.length > beforeBuffer.length) {
        const newContent = buf.slice(beforeBuffer.length);
        const clean = stripAnsi(newContent);
        const lines = clean.split("\n").filter((l) => l.trim());
        if (lines.length > 1) {
          const lastLine = lines[lines.length - 1].trimEnd();
          if (promptRe.test(lastLine)) {
            const outputLines = lines.slice(1, -1);
            return {
              type: "output",
              output: outputLines.join("\n"),
              termId: tab.termId,
            };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const finalResp = await daemonRequest({
      type: "read-buffer",
      term_id: tab.termId,
    });
    const delta = (finalResp.buffer || "").slice(beforeBuffer.length);
    throw new Error(
      `Command timed out after ${timeoutMs}ms. Partial output: ${stripAnsi(delta).trim()}`,
    );
  };

  handlers["session-term-close"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (msg.tabIndex === undefined) throw new Error("tabIndex required");
    const terminals = await getSessionTerminals(msg.sessionId);
    const tab = terminals[msg.tabIndex];
    if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
    await daemonRequest({ type: "kill", term_id: tab.termId });
    const mainWindow = _getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("api-term-closed", msg.sessionId, tab.termId);
    }
    return { type: "ok" };
  };

  return handlers;
}

module.exports = {
  init,
  splitArgs,
  sharedHandlers,
  ipcArgMap,
  apiResponseMap,
  buildApiHandlers,
};
