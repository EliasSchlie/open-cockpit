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
const {
  findSlotBySessionId: findSlotBySessionIdInPool,
  findSlotByIndex: findSlotByIndexInPool,
  resolveSlot: resolveSlotInPool,
} = require("./pool");
const { STATUS, POOL_STATUS, INITIATOR } = require("./session-statuses");
const { IDLE_SIGNALS_DIR } = require("./paths");
const { secureWriteFileSync } = require("./secure-fs");
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
  withPoolLock,
  poll,
  readTerminalBuffer,
  stripAnsi,
  sendCommandToTerminal,
  validateSessionId,
  validateTermId,
  readSessionGraph,
  recordSessionRelation,
  enrichSessionsWithGraphData,
  readPool,
  writePool,
  syncPoolStatuses,
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
  readOffloadMeta,
  withFreshSlot,
  readIntention,
  writeIntention,
  getCachedClaudePath,
  acceptTrustPrompt,
} = require("./pool-manager");

let _getMainWindow = () => null;

function init({ getMainWindow }) {
  _getMainWindow = getMainWindow;
}

/** Get main window or throw if unavailable. */
function _requireMainWindow() {
  const win = _getMainWindow();
  if (!win || win.isDestroyed()) throw new Error("No window");
  return win;
}

// --- Pool interaction helpers (used by API-only handlers) ---

function findSlotBySessionId(sessionId) {
  return findSlotBySessionIdInPool(readPool(), sessionId);
}

function findSlotByIndex(slotIndex) {
  return findSlotByIndexInPool(readPool(), slotIndex);
}

function resolveSlot(msg) {
  return resolveSlotInPool(readPool(), msg);
}

async function getTerminalBuffer(termId) {
  const resp = await daemonRequest({ type: "list" });
  const pty = resp.ptys.find((p) => p.termId === termId);
  return pty ? pty.buffer || "" : "";
}

async function getSessionTerminals(sessionId) {
  validateSessionId(sessionId);
  const resp = await daemonRequest({ type: "list" });
  const pool = readPool();
  const slot = pool?.slots.find((s) => s.sessionId === sessionId);
  const tuiTermId = slot?.termId ?? null;

  const terms = resp.ptys
    .filter((p) => p.sessionId === sessionId && !p.exited)
    .sort((a, b) => a.termId - b.termId);

  let shellCount = 0;
  return terms.map((p, i) => {
    const isTui = p.termId === tuiTermId;
    if (!isTui) shellCount++;
    return {
      termId: p.termId,
      index: i,
      label: isTui ? "Claude" : `Shell ${shellCount}`,
      isTui,
      pid: p.pid,
      cwd: p.cwd,
      buffer: p.buffer || "",
    };
  });
}

async function sendPromptToTerminal(termId, prompt) {
  await sendCommandToTerminal(termId, prompt);
}

async function getEffectiveSlotStatus(slot) {
  const sessions = await getSessions();
  const session = sessions.find((s) => s.sessionId === slot.sessionId);
  if (!session) return slot.status;
  if (session.status === STATUS.IDLE) return POOL_STATUS.IDLE;
  if (session.status === STATUS.PROCESSING) return POOL_STATUS.BUSY;
  if (session.status === STATUS.FRESH) return POOL_STATUS.FRESH;
  if (session.status === STATUS.TYPING) return POOL_STATUS.TYPING;
  return slot.status;
}

function waitForSessionIdle(sessionId, timeoutMs = 300000) {
  return poll(
    async () => {
      const sessions = await getSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (session && session.status === STATUS.IDLE) return true;
      if (session && !session.alive) throw new Error("Session process died");
      return null;
    },
    {
      interval: 1000,
      initialDelay: 1000,
      timeout: timeoutMs,
      label: "waiting for session to become idle",
    },
  );
}

// --- Shared handler registry (serves both IPC and API) ---
// Each handler takes a params object and returns raw data.
// IPC adapter: converts positional args -> params, returns raw result.
// API adapter: passes msg as params, wraps result with { type, ... }.

const sharedHandlers = {
  "get-sessions": async () => {
    const sessions = await getSessions();
    // syncPoolStatuses returns the pool with up-to-date slot statuses.
    // We annotate poolStatus here (not in getSessions) to avoid stale reads.
    const pool = await syncPoolStatuses(sessions);
    if (pool) {
      const slotMap = new Map(
        pool.slots.filter((s) => s.sessionId).map((s) => [s.sessionId, s]),
      );
      for (const s of sessions) {
        const slot = slotMap.get(s.sessionId);
        if (slot) {
          s.poolStatus = slot.status;
          if (slot.pinnedUntil) s.pinnedUntil = slot.pinnedUntil;
        }
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
    return { termId: resp.termId, pid: resp.pid };
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
  "pool-health": async () => getPoolHealth(),
  "pool-read": () => readPool(),
  "pool-destroy": async () => poolDestroy(),
  "pool-clean": async () => poolClean(),
  "pool-get-flags": () => getPoolFlags(),
  "pool-set-flags": ({ flags }) => {
    setPoolFlags(flags);
    return flags;
  },
  "pool-get-min-fresh": () => getMinFreshSlots(),
  "pool-set-min-fresh": ({ minFreshSlots }) => {
    setMinFreshSlots(minFreshSlots);
    return minFreshSlots;
  },
  "pool-resume": async ({ sessionId }) => poolResume(sessionId),
  "archive-session": async ({ sessionId }) => archiveSession(sessionId),
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
    // Accept trust prompt in background (non-blocking)
    acceptTrustPrompt(resp.termId);
    return { termId: resp.termId, pid: resp.pid };
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
  "pool-health": () => ({}),
  "pool-read": () => ({}),
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
  "pool-health": (health) => ({ type: "health", health }),
  "pool-read": (pool) => ({ type: "pool", pool }),
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

  handlers["quit"] = async () => {
    const { app } = require("electron");
    setTimeout(() => app.quit(), 100);
    return { type: "ok", message: "Quitting..." };
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
    // executeJavaScript is the standard Electron pattern for main→renderer data retrieval.
    // The global is set up in renderer.js and returns a plain object (safe to serialize).
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

  handlers["pty-read"] = async (msg) => {
    validateTermId(msg.termId);
    const resp = await daemonRequest({ type: "list" });
    const p = resp.ptys.find((p) => p.termId === msg.termId);
    return { type: "buffer", buffer: p ? p.buffer : null };
  };

  handlers["pool-start"] = async (msg) => {
    if (!msg.prompt) throw new Error("prompt required");
    const result = await withFreshSlot(async (pool, slot) => {
      await sendPromptToTerminal(slot.termId, msg.prompt);
      slot.status = POOL_STATUS.BUSY;
      writePool(pool);
      return {
        type: "started",
        sessionId: slot.sessionId,
        termId: slot.termId,
        slotIndex: slot.index,
      };
    });
    recordSessionRelation(
      result.sessionId,
      msg.parentSessionId || null,
      msg.parentSessionId ? INITIATOR.MODEL : INITIATOR.USER,
    );
    return result;
  };

  handlers["pool-followup"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (!msg.prompt) throw new Error("prompt required");

    // Check if session is offloaded — auto-resume it first
    const pool = readPool();
    const liveSlot = pool?.slots?.find((s) => s.sessionId === msg.sessionId);
    if (!liveSlot && readOffloadMeta(msg.sessionId)) {
      await poolResume(msg.sessionId);
      // Wait for the resumed session to become idle before sending prompt
      await waitForSessionIdle(msg.sessionId, 60000);
    }

    return withPoolLock(async () => {
      const { pool: p, slot } = findSlotBySessionId(msg.sessionId);
      const status = await getEffectiveSlotStatus(slot);
      if (status !== POOL_STATUS.IDLE)
        throw new Error(`Session is ${status}, expected idle`);
      await sendPromptToTerminal(slot.termId, msg.prompt);
      slot.status = POOL_STATUS.BUSY;
      writePool(p);
      return {
        type: "started",
        sessionId: slot.sessionId,
        termId: slot.termId,
        slotIndex: slot.index,
      };
    });
  };

  handlers["pool-wait"] = async (msg) => {
    const timeout = msg.timeout || 300000;
    if (msg.sessionId) {
      validateSessionId(msg.sessionId);
      try {
        const { slot } = findSlotBySessionId(msg.sessionId);
        await waitForSessionIdle(msg.sessionId, timeout);
        const buffer = await getTerminalBuffer(slot.termId);
        return { type: "result", sessionId: msg.sessionId, buffer };
      } catch (err) {
        return { type: "error", error: err.message, id: msg.id };
      }
    }
    // Wait by slot index (used by resume --block where session ID changes)
    if (msg.slotIndex !== undefined) {
      findSlotByIndex(msg.slotIndex);
      try {
        const result = await poll(
          async () => {
            const pool = readPool();
            const slot = pool?.slots?.[msg.slotIndex];
            if (!slot?.sessionId) return null;
            const sessions = await getSessions();
            const session = sessions.find(
              (s) => s.sessionId === slot.sessionId,
            );
            if (session && session.status === STATUS.IDLE) return slot;
            if (session && !session.alive)
              throw new Error("Session process died");
            return null;
          },
          {
            interval: 1000,
            initialDelay: 1000,
            timeout,
            label: "waiting for slot to become idle",
          },
        );
        const buffer = await getTerminalBuffer(result.termId);
        return { type: "result", sessionId: result.sessionId, buffer };
      } catch (err) {
        return { type: "error", error: err.message, id: msg.id };
      }
    }
    // No sessionId or slotIndex: wait for any busy session to become idle
    const pool = readPool();
    if (!pool) throw new Error("Pool not initialized");
    const busySlots = pool.slots.filter((s) => s.status === POOL_STATUS.BUSY);
    if (busySlots.length === 0) throw new Error("No busy sessions to wait for");
    const finished = await poll(
      async () => {
        const sessions = await getSessions();
        for (const s of busySlots) {
          const session = sessions.find(
            (sess) => sess.sessionId === s.sessionId,
          );
          if (session && session.status === STATUS.IDLE) return s;
        }
        return null;
      },
      {
        interval: 1000,
        initialDelay: 1000,
        timeout,
        label: "waiting for session to become idle",
      },
    );
    const buffer = await getTerminalBuffer(finished.termId);
    return { type: "result", sessionId: finished.sessionId, buffer };
  };

  handlers["pool-capture"] = async (msg) => {
    const { slot } = resolveSlot(msg);
    const buffer = await getTerminalBuffer(slot.termId);
    return {
      type: "buffer",
      sessionId: slot.sessionId,
      slotIndex: slot.index,
      buffer,
    };
  };

  handlers["pool-result"] = async (msg) => {
    const { slot } = resolveSlot(msg);
    const status = await getEffectiveSlotStatus(slot);
    if (status === POOL_STATUS.BUSY) {
      throw new Error("Session is still running");
    }
    const buffer = await getTerminalBuffer(slot.termId);
    return {
      type: "result",
      sessionId: slot.sessionId,
      slotIndex: slot.index,
      buffer,
    };
  };

  handlers["pool-input"] = async (msg) => {
    if (msg.data === undefined) throw new Error("data required");
    const { slot } = resolveSlot(msg);
    daemonSendSafe({ type: "write", termId: slot.termId, data: msg.data });
    return { type: "ok" };
  };

  handlers["pool-pin"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const duration = msg.duration || 120;
    return withPoolLock(async () => {
      const { pool, slot } = findSlotBySessionId(msg.sessionId);
      slot.pinnedUntil = new Date(Date.now() + duration * 1000).toISOString();
      writePool(pool);
      return { type: "ok", pinnedUntil: slot.pinnedUntil };
    });
  };

  handlers["pool-unpin"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    return withPoolLock(async () => {
      const { pool, slot } = findSlotBySessionId(msg.sessionId);
      delete slot.pinnedUntil;
      writePool(pool);
      return { type: "ok" };
    });
  };

  handlers["pool-stop-session"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const { slot } = findSlotBySessionId(msg.sessionId);
    daemonSendSafe({ type: "write", termId: slot.termId, data: "\x1b" });
    await new Promise((r) => setTimeout(r, 200));
    daemonSendSafe({ type: "write", termId: slot.termId, data: "\x1b" });
    const stopPid = slot.pid;
    const stopSessionId = msg.sessionId;
    if (stopPid) {
      setTimeout(async () => {
        const sigFile = path.join(IDLE_SIGNALS_DIR, String(stopPid));
        if (fs.existsSync(sigFile)) return;
        const transcript = (await findJsonlPath(stopSessionId)) || "";
        const cwd = (await getCwdFromJsonl(stopSessionId)) || "";
        const signal = JSON.stringify({
          cwd,
          session_id: stopSessionId,
          transcript,
          ts: Math.floor(Date.now() / 1000),
          trigger: "api-stop",
        });
        try {
          secureWriteFileSync(sigFile, signal + "\n");
        } catch {
          /* ignore -- session may be dead */
        }
      }, 6000);
    }
    return { type: "ok", sessionId: msg.sessionId };
  };

  handlers["get-session-graph"] = async () => ({
    type: "session-graph",
    graph: readSessionGraph(),
  });

  handlers["slot-read"] = async (msg) => {
    const { slot } = findSlotByIndex(msg.slotIndex);
    const buffer = await getTerminalBuffer(slot.termId);
    return {
      type: "buffer",
      slotIndex: slot.index,
      sessionId: slot.sessionId,
      buffer,
    };
  };

  handlers["slot-write"] = async (msg) => {
    if (msg.data === undefined) throw new Error("data required");
    const { slot } = findSlotByIndex(msg.slotIndex);
    daemonSendSafe({ type: "write", termId: slot.termId, data: msg.data });
    return { type: "ok" };
  };

  handlers["slot-status"] = async (msg) => {
    const { slot } = findSlotByIndex(msg.slotIndex);
    const healthStatus = slot.sessionId
      ? await getEffectiveSlotStatus(slot)
      : slot.status;
    return {
      type: "slot",
      slot: {
        index: slot.index,
        termId: slot.termId,
        pid: slot.pid,
        status: slot.status,
        sessionId: slot.sessionId,
        healthStatus,
        createdAt: slot.createdAt,
      },
    };
  };

  handlers["session-terminals"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    const terminals = await getSessionTerminals(msg.sessionId);
    return {
      type: "terminals",
      terminals: terminals.map(({ buffer, ...rest }) => rest),
    };
  };

  handlers["session-term-read"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (msg.tabIndex === undefined) throw new Error("tabIndex required");
    const terminals = await getSessionTerminals(msg.sessionId);
    const tab = terminals[msg.tabIndex];
    if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
    return { type: "buffer", termId: tab.termId, buffer: tab.buffer };
  };

  handlers["session-term-write"] = async (msg) => {
    if (!msg.sessionId) throw new Error("sessionId required");
    if (msg.tabIndex === undefined) throw new Error("tabIndex required");
    if (msg.data === undefined) throw new Error("data required");
    const terminals = await getSessionTerminals(msg.sessionId);
    const tab = terminals[msg.tabIndex];
    if (!tab) throw new Error(`No terminal at tab index ${msg.tabIndex}`);
    daemonSendSafe({ type: "write", termId: tab.termId, data: msg.data });
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
      sessionId: msg.sessionId,
    });
    const terminals = await getSessionTerminals(msg.sessionId);
    const newTab = terminals.find((t) => t.termId === resp.termId);
    const mainWindow = _getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        "api-term-opened",
        msg.sessionId,
        resp.termId,
      );
    }
    return {
      type: "spawned",
      termId: resp.termId,
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
    if (tab.isTui) throw new Error("Cannot run commands in the Claude TUI tab");
    const beforeBuffer = tab.buffer;
    daemonSendSafe({
      type: "write",
      termId: tab.termId,
      data: msg.command + "\r",
    });
    const promptRe = /[\$\u276F%#>] *$/;
    const deadline = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() < deadline) {
      const buf = await readTerminalBuffer(tab.termId);
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
    const finalBuf = await readTerminalBuffer(tab.termId);
    const delta = finalBuf.slice(beforeBuffer.length);
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
    if (tab.isTui) {
      throw new Error("Cannot close the Claude TUI tab");
    }
    await daemonRequest({ type: "kill", termId: tab.termId });
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
