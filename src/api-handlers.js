const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");
const {
  findSlotBySessionId: findSlotBySessionIdInPool,
  findSlotByIndex: findSlotByIndexInPool,
  resolveSlot: resolveSlotInPool,
} = require("./pool");
const {
  STATUS,
  POOL_STATUS,
  INITIATOR,
  sessionToPoolStatus,
} = require("./session-statuses");
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
  withFreshSlot,
  readIntention,
  writeIntention,
  getCachedClaudePath,
  acceptTrustPrompt,
  getTerminalDims,
} = require("./pool-manager");

let _getMainWindow = () => null;

function init({ getMainWindow }) {
  _getMainWindow = getMainWindow;
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
  return sessionToPoolStatus(session.status) ?? slot.status;
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
  "pty-spawn": async ({ cwd, cmd, args, sessionId, cols, rows }) => {
    // Use renderer-provided dims, fall back to last-known terminal dims
    const dims = cols && rows ? { cols, rows } : getTerminalDims() || {};
    const resp = await daemonRequest({
      type: "spawn",
      cwd,
      cmd,
      args,
      sessionId,
      ...dims,
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
  "spawn-custom-session": async ({ cwd, flags }) => {
    const claudePath = getCachedClaudePath();
    const args = ["--dangerously-skip-permissions"];
    if (flags) {
      // Split flags string into args (simple space-split, respects quotes)
      const extraArgs = flags.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      args.push(...extraArgs.map((a) => a.replace(/^["']|["']$/g, "")));
    }
    // Expand ~ to home directory
    let resolvedCwd = cwd || "~";
    if (resolvedCwd.startsWith("~")) {
      resolvedCwd = path.join(os.homedir(), resolvedCwd.slice(1));
    }
    const dims = getTerminalDims() || {};
    const resp = await daemonRequest({
      type: "spawn",
      cwd: resolvedCwd,
      cmd: claudePath,
      args,
      env: { OPEN_COCKPIT_CUSTOM: "1" },
      ...dims,
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
    return withPoolLock(async () => {
      const { pool, slot } = findSlotBySessionId(msg.sessionId);
      const status = await getEffectiveSlotStatus(slot);
      if (status !== POOL_STATUS.IDLE)
        throw new Error(`Session is ${status}, expected idle`);
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
    const dims = getTerminalDims() || {};
    const resp = await daemonRequest({
      type: "spawn",
      cwd: cwd || os.homedir(),
      sessionId: msg.sessionId,
      ...dims,
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
    const marker = `__COCKPIT_${crypto.randomBytes(8).toString("hex")}__`;
    const startMarker = `START_${marker}`;
    const endMarker = `END_${marker}`;
    const wrapped = `echo ${startMarker}; ${msg.command}; echo ${endMarker}`;

    const extractOutput = (buf) => {
      const clean = stripAnsi(buf);
      const startIdx = clean.lastIndexOf(startMarker);
      if (startIdx < 0) return null;
      const endIdx = clean.indexOf(endMarker, startIdx);
      const raw = clean.slice(
        startIdx + startMarker.length,
        endIdx >= 0 ? endIdx : undefined,
      );
      return { output: raw.trim(), complete: endIdx >= 0 };
    };

    daemonSendSafe({
      type: "write",
      termId: tab.termId,
      data: wrapped + "\r",
    });
    const deadline = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() < deadline) {
      const buf = await readTerminalBuffer(tab.termId);
      const result = extractOutput(buf);
      if (result?.complete) {
        return {
          type: "output",
          output: result.output,
          termId: tab.termId,
        };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const finalBuf = await readTerminalBuffer(tab.termId);
    const result = extractOutput(finalBuf);
    throw new Error(
      `Command timed out after ${timeoutMs}ms. Partial output: ${result?.output || ""}`,
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
  sharedHandlers,
  ipcArgMap,
  apiResponseMap,
  buildApiHandlers,
};
