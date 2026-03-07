import {
  showNotification,
  STATUS_CLASSES,
  escapeHtml,
} from "./renderer-state.js";
import { STATUS, POOL_STATUS } from "./session-statuses.js";
import { FitAddon } from "@xterm/addon-fit";
import {
  createTerminal,
  wireTerminalInput,
  popupTerminals,
  findTerminalEntry,
} from "./terminal-manager.js";
import { formatShortcutDisplay } from "./command-palette.js";

// --- Cross-module dependencies (set via initPoolUi) ---
let _actions = {};

/**
 * Initialize pool UI with dependencies from the main renderer module.
 *
 * @param {Object} actions
 * @param {Function} actions.loadSessions — refresh session sidebar
 * @param {Function} actions.focusTerminal — focus a terminal tab
 * @param {Function} actions.loadDirColors — reload directory colors
 * @param {Array} actions.COMMANDS — command palette commands array
 */
export function initPoolUi(actions) {
  _actions = actions;

  // Build shortcut labels from COMMANDS entries
  if (_actions.COMMANDS) {
    for (const cmd of _actions.COMMANDS) {
      if (cmd.shortcutAction) SHORTCUT_LABELS[cmd.shortcutAction] = cmd.label;
    }
  }
  // Actions only reachable via input events (no COMMANDS entry)
  SHORTCUT_LABELS["next-terminal-tab-alt"] = "Next Tab (Alt)";
  SHORTCUT_LABELS["prev-terminal-tab-alt"] = "Previous Tab (Alt)";

  // Wire up the pool settings button
  const poolSettingsBtn = document.getElementById("pool-settings-btn");
  poolSettingsBtn.addEventListener("click", () => showPoolSettings());
}

// --- Module-local state ---
let poolSettingsInterval = null;
let poolSettingsVisible = false;
let shortcutConfig = {};
const SHORTCUT_LABELS = {};

function poolStatusDot(status) {
  const cls = STATUS_CLASSES[status] || "dead";
  return `<span class="session-status ${cls}" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span>`;
}

// --- Slot Terminal Popup (interactive) ---
async function openSlotTerminalPopup(slot) {
  // Don't open popup for dead/unknown slots — no terminal to attach to
  const status = slot.healthStatus || slot.status;
  if (status === STATUS.DEAD || !slot.termId) {
    showNotification("Cannot open terminal for dead slot");
    return;
  }

  // Close existing popup if any (run its cleanup)
  const existingPopup = document.getElementById("slot-terminal-popup");
  if (existingPopup && existingPopup._cleanup) existingPopup._cleanup();
  else if (existingPopup) existingPopup.remove();

  const overlay = document.createElement("div");
  overlay.id = "slot-terminal-popup";
  overlay.className = "offload-menu-overlay";

  const label =
    slot.intentionHeading ||
    slot.sessionId?.slice(0, 8) ||
    `slot-${slot.index}`;

  overlay.innerHTML = `
    <div class="slot-terminal-dialog">
      <div class="slot-terminal-header">
        <span class="slot-terminal-title">${escapeHtml(label)}</span>
        <button class="snapshot-close slot-terminal-close">\u2715</button>
      </div>
      <div class="slot-terminal-mount"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const mountEl = overlay.querySelector(".slot-terminal-mount");
  const closeBtn = overlay.querySelector(".slot-terminal-close");

  const term = createTerminal();

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(mountEl);

  // Wire input to the PTY so the popup is interactive
  wireTerminalInput(term, slot.termId);

  // Register in popupTerminals so global data handlers can route data here.
  // Data is forwarded to both the main terminal entry (if any) and the popup entry.
  const popupEntry = { termId: slot.termId, term, fitAddon };
  popupTerminals.set(slot.termId, popupEntry);

  try {
    await window.api.ptyAttach(slot.termId);
  } catch (err) {
    showNotification(`Failed to attach: ${err.message}`);
    popupTerminals.delete(slot.termId);
    term.dispose();
    overlay.remove();
    return;
  }

  // Debounced fit — avoids thrashing during resize and only sends ptyResize
  // when dimensions actually change.
  let fitPending = false;
  let prevCols = term.cols;
  let prevRows = term.rows;
  const doFit = () => {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(() => {
      fitPending = false;
      fitAddon.fit();
      const { cols, rows } = term;
      if (cols !== prevCols || rows !== prevRows) {
        prevCols = cols;
        prevRows = rows;
        window.api.ptyResize(slot.termId, cols, rows);
      }
    });
  };

  // Initial fit + focus (unconditional ptyResize for first frame)
  requestAnimationFrame(() => {
    fitAddon.fit();
    prevCols = term.cols;
    prevRows = term.rows;
    window.api.ptyResize(slot.termId, term.cols, term.rows);
    term.focus();
  });

  const resizeObserver = new ResizeObserver(doFit);
  resizeObserver.observe(mountEl);

  // Cleanup function — also stored on overlay for programmatic close
  const cleanup = () => {
    resizeObserver.disconnect();
    popupTerminals.delete(slot.termId);
    // Only detach if there's no other terminal entry still using this termId
    // (i.e. the session might be open in the main view)
    const otherEntry = findTerminalEntry(slot.termId);
    if (otherEntry) {
      // Restore PTY size to the main tab's dimensions
      window.api.ptyResize(
        slot.termId,
        otherEntry.term.cols,
        otherEntry.term.rows,
      );
    } else {
      window.api.ptyDetach(slot.termId).catch(() => {});
    }
    term.dispose();
    overlay.remove();
  };
  overlay._cleanup = cleanup;

  closeBtn.addEventListener("click", cleanup);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cleanup();
  });
}

// --- Pool Health Badge ---
async function updatePoolHealthBadge() {
  const poolSettingsBtn = document.getElementById("pool-settings-btn");
  const pool = await window.api.poolRead();
  const errors = pool
    ? pool.slots.filter((s) => s.status === POOL_STATUS.ERROR).length
    : 0;
  poolSettingsBtn.dataset.errors = errors;
  poolSettingsBtn.title =
    errors > 0
      ? `Pool settings — ${errors} slot${errors > 1 ? "s" : ""} in error`
      : "Pool settings";
}

function stopPoolSettingsPolling() {
  if (poolSettingsInterval) {
    clearInterval(poolSettingsInterval);
    poolSettingsInterval = null;
  }
}

// --- Pool slot rendering ---
function renderPoolSlotsHtml(health) {
  if (!health.initialized) return "";
  return health.slots
    .map((slot) => {
      const status = slot.healthStatus || slot.status;
      const label =
        slot.intentionHeading ||
        slot.sessionId?.slice(0, 8) ||
        `slot-${slot.index}`;
      const pinned =
        slot.pinnedUntil && new Date(slot.pinnedUntil) > new Date();
      const pinBadge = pinned
        ? '<span class="pool-slot-pin" title="Pinned">📌</span>'
        : "";
      return `<div class="pool-slot-row pool-slot-clickable" data-slot-index="${slot.index}">
        ${poolStatusDot(status)}
        <span class="pool-slot-label">${escapeHtml(label)}</span>
        ${pinBadge}
        <span class="pool-slot-status">${status}</span>
      </div>`;
    })
    .join("");
}

function renderPoolCountsHtml(health) {
  if (!health.initialized) return "Pool not initialized";
  return Object.entries(health.counts)
    .map(([k, v]) => `${poolStatusDot(k)} ${k}: ${v}`)
    .join("&nbsp;&nbsp;&nbsp;");
}

function closePoolSettings(overlay) {
  stopPoolSettingsPolling();
  if (overlay._keyHandler) {
    document.removeEventListener("keydown", overlay._keyHandler, true);
  }
  overlay.remove();
}

// --- Pool Settings Panel ---
async function showPoolSettings() {
  stopPoolSettingsPolling();
  const existing = document.getElementById("pool-settings");
  if (existing) closePoolSettings(existing);

  const health = await window.api.poolHealth();

  const overlay = document.createElement("div");
  overlay.id = "pool-settings";
  overlay.className = "offload-menu-overlay";

  const slotsHtml = renderPoolSlotsHtml(health);
  const countsHtml = renderPoolCountsHtml(health);

  overlay.innerHTML = `
    <div class="pool-settings-dialog">
      <div class="pool-settings-header">
        <span>Pool Settings</span>
        <button class="snapshot-close pool-close">\u2715</button>
      </div>
      <div class="pool-settings-body">
        <div class="pool-health-summary">${countsHtml}</div>
        ${
          health.initialized
            ? `
          <div class="pool-slots-list">${slotsHtml}</div>
          <div class="pool-controls">
            <label class="pool-size-label">
              Pool size:
              <input type="number" class="pool-size-input" value="${health.poolSize}" min="1" max="20">
            </label>
            <button class="offload-menu-btn pool-resize-btn">Resize</button>
            <button class="offload-menu-btn pool-reload-btn">Reload Sessions</button>
            <button class="offload-menu-btn pool-clean-btn">Clean Idle</button>
            <button class="offload-menu-btn pool-destroy-btn">Destroy</button>
            <button class="offload-menu-btn pool-reinit-btn">Reinitialize</button>
          </div>
        `
            : `
          <div class="pool-controls">
            <label class="pool-size-label">
              Pool size:
              <input type="number" class="pool-size-input" value="10" min="1" max="20">
            </label>
            <button class="offload-menu-btn offload-menu-load pool-init-btn">Initialize Pool</button>
          </div>
        `
        }
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // --- Keyboard navigation state ---
  // "top" = navigating between pool-slots-block and buttons
  // "slots" = navigating individual pool slots
  let navLevel = "top";
  let topIndex = 0;
  let slotIndex = 0;

  // Returns the list of top-level navigable items (pool-slots-list + buttons)
  function getTopItems() {
    const items = [];
    const slotsList = overlay.querySelector(".pool-slots-list");
    if (slotsList) items.push(slotsList);
    for (const btn of overlay.querySelectorAll(
      ".pool-controls .offload-menu-btn",
    ))
      items.push(btn);
    return items;
  }

  function getSlotRows() {
    return Array.from(
      overlay.querySelectorAll(".pool-slots-list .pool-slot-row"),
    );
  }

  function clearAllSelection() {
    for (const el of overlay.querySelectorAll(".kb-selected"))
      el.classList.remove("kb-selected");
  }

  function applySelection() {
    clearAllSelection();
    if (navLevel === "top") {
      const items = getTopItems();
      if (items[topIndex]) items[topIndex].classList.add("kb-selected");
    } else {
      const rows = getSlotRows();
      // Clamp index after poll refresh may have removed slots
      if (rows.length > 0) slotIndex = Math.min(slotIndex, rows.length - 1);
      if (rows[slotIndex]) {
        rows[slotIndex].classList.add("kb-selected");
        rows[slotIndex].scrollIntoView({ block: "nearest" });
      }
    }
  }

  // Apply initial selection
  applySelection();

  overlay._keyHandler = (e) => {
    // Skip if a terminal popup is open on top
    if (document.getElementById("slot-terminal-popup")) return;
    // Skip if an input is focused (e.g. pool size number input)
    if (overlay.querySelector("input:focus")) return;

    const { key } = e;

    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (navLevel === "slots") {
        navLevel = "top";
        applySelection();
      } else {
        closePoolSettings(overlay);
      }
      return;
    }

    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const delta = key === "ArrowDown" ? 1 : -1;
      if (navLevel === "top") {
        const items = getTopItems();
        if (items.length === 0) return;
        topIndex = Math.max(0, Math.min(items.length - 1, topIndex + delta));
        applySelection();
      } else {
        const rows = getSlotRows();
        if (rows.length === 0) return;
        slotIndex = Math.max(0, Math.min(rows.length - 1, slotIndex + delta));
        applySelection();
      }
      return;
    }

    if (key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (navLevel === "top") {
        const items = getTopItems();
        const item = items[topIndex];
        if (!item) return;
        if (item.classList.contains("pool-slots-list")) {
          // Enter the slots block
          navLevel = "slots";
          slotIndex = 0;
          applySelection();
        } else {
          // It's a button — click it
          item.click();
        }
      } else {
        // Inside slots — open terminal popup for selected slot
        const rows = getSlotRows();
        const row = rows[slotIndex];
        if (row) row.click();
      }
      return;
    }
  };
  document.addEventListener("keydown", overlay._keyHandler, true);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePoolSettings(overlay);
  });
  overlay
    .querySelector(".pool-close")
    .addEventListener("click", () => closePoolSettings(overlay));

  // Poll for health updates while dialog is open
  poolSettingsInterval = setInterval(async () => {
    // Stop polling if dialog was removed externally
    if (!document.getElementById("pool-settings")) {
      stopPoolSettingsPolling();
      return;
    }
    try {
      const h = await window.api.poolHealth();
      const summaryEl = overlay.querySelector(".pool-health-summary");
      if (summaryEl) summaryEl.innerHTML = renderPoolCountsHtml(h);
      const slotsEl = overlay.querySelector(".pool-slots-list");
      if (slotsEl) {
        slotsEl.innerHTML = renderPoolSlotsHtml(h);
        // Re-apply selection after poll refresh (innerHTML wipes classes)
        applySelection();
      }
    } catch {
      // Ignore transient errors — next poll will retry
    }
  }, 3000);

  // Slot row click → open terminal popup (delegated to survive innerHTML poll updates)
  const slotsListEl = overlay.querySelector(".pool-slots-list");
  if (slotsListEl) {
    slotsListEl.addEventListener("click", async (e) => {
      const row = e.target.closest(".pool-slot-clickable");
      if (!row) return;
      const clickedSlotIndex = parseInt(row.dataset.slotIndex, 10);
      const currentHealth = await window.api.poolHealth();
      const slot = currentHealth.slots.find(
        (s) => s.index === clickedSlotIndex,
      );
      if (slot) openSlotTerminalPopup(slot);
    });
  }

  // Init button
  const initBtn = overlay.querySelector(".pool-init-btn");
  if (initBtn) {
    initBtn.addEventListener("click", async () => {
      const size = parseInt(
        overlay.querySelector(".pool-size-input").value,
        10,
      );
      if (isNaN(size) || size < 1 || size > 20) {
        showNotification("Pool size must be between 1 and 20");
        return;
      }
      initBtn.textContent = "Initializing...";
      initBtn.disabled = true;
      try {
        await window.api.poolInit(size);
        showNotification(`Pool initialized (${size} slots)`);
        await _actions.loadSessions();
        showPoolSettings();
      } catch (err) {
        initBtn.textContent = "Initialize Pool";
        initBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Resize button
  const resizeBtn = overlay.querySelector(".pool-resize-btn");
  if (resizeBtn) {
    resizeBtn.addEventListener("click", async () => {
      const newSize = parseInt(
        overlay.querySelector(".pool-size-input").value,
        10,
      );
      if (isNaN(newSize) || newSize < 1 || newSize > 20) {
        showNotification("Pool size must be between 1 and 20");
        return;
      }
      resizeBtn.textContent = "Resizing...";
      resizeBtn.disabled = true;
      try {
        await window.api.poolResize(newSize);
        showNotification(`Pool resized to ${newSize} slots`);
        await _actions.loadSessions();
        showPoolSettings();
      } catch (err) {
        resizeBtn.textContent = "Resize";
        resizeBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Reload button
  const reloadBtn = overlay.querySelector(".pool-reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", async () => {
      closePoolSettings(overlay);
      await _actions.loadDirColors();
      await _actions.loadSessions();
      showNotification("Sessions reloaded");
    });
  }

  // Clean idle button
  const cleanBtn = overlay.querySelector(".pool-clean-btn");
  if (cleanBtn) {
    cleanBtn.addEventListener("click", async () => {
      cleanBtn.textContent = "Cleaning...";
      cleanBtn.disabled = true;
      try {
        const cleaned = await window.api.poolClean();
        showNotification(
          `Cleaned ${cleaned} idle session${cleaned !== 1 ? "s" : ""}`,
        );
        await _actions.loadSessions();
        showPoolSettings();
      } catch (err) {
        cleanBtn.textContent = "Clean Idle";
        cleanBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Destroy button
  const destroyBtn = overlay.querySelector(".pool-destroy-btn");
  if (destroyBtn) {
    destroyBtn.addEventListener("click", async () => {
      destroyBtn.textContent = "Destroying...";
      destroyBtn.disabled = true;
      try {
        await window.api.poolDestroy();
        showNotification("Pool destroyed");
        await _actions.loadSessions();
        showPoolSettings();
      } catch (err) {
        destroyBtn.textContent = "Destroy";
        destroyBtn.disabled = false;
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Reinitialize button (destroy + init)
  const reinitBtn = overlay.querySelector(".pool-reinit-btn");
  if (reinitBtn) {
    reinitBtn.addEventListener("click", async () => {
      const size = parseInt(
        overlay.querySelector(".pool-size-input").value,
        10,
      );
      if (isNaN(size) || size < 1 || size > 20) {
        showNotification("Pool size must be between 1 and 20");
        return;
      }
      reinitBtn.textContent = "Reinitializing...";
      reinitBtn.disabled = true;
      try {
        await window.api.poolDestroy();
      } catch (err) {
        reinitBtn.textContent = "Reinitialize";
        reinitBtn.disabled = false;
        showNotification(`Destroy failed: ${err.message}`);
        return;
      }
      try {
        await window.api.poolInit(size);
        showNotification(`Pool reinitialized (${size} slots)`);
      } catch (err) {
        showNotification(`Pool destroyed but re-init failed: ${err.message}`);
      }
      await _actions.loadSessions();
      showPoolSettings();
    });
  }
}

// --- Shortcut Settings UI ---
async function showShortcutSettings() {
  const existing = document.getElementById("shortcut-settings");
  if (existing) existing.remove();

  const shortcuts = await window.api.getShortcuts();
  shortcutConfig = shortcuts;

  // Track active keydown listener for cleanup
  let activeKeyHandler = null;

  function cleanupRecording() {
    if (activeKeyHandler) {
      document.removeEventListener("keydown", activeKeyHandler, true);
      activeKeyHandler = null;
    }
  }

  const overlay = document.createElement("div");
  overlay.id = "shortcut-settings";
  overlay.className = "offload-menu-overlay";

  const actionIds = Object.keys(SHORTCUT_LABELS);
  const rows = actionIds
    .map((id) => {
      const label = SHORTCUT_LABELS[id];
      const current = shortcuts[id] || "";
      const display = formatShortcutDisplay(current) || "—";
      return `<div class="shortcut-row" data-action="${id}">
        <span class="shortcut-label">${label}</span>
        <button class="shortcut-key-btn" title="Click to rebind">${display}</button>
        <button class="shortcut-reset-btn" title="Reset to default">↺</button>
      </div>`;
    })
    .join("");

  overlay.innerHTML = `
    <div class="shortcut-settings-dialog">
      <div class="pool-settings-header">
        <span>Keyboard Shortcuts</span>
        <button class="close-dialog-btn">✕</button>
      </div>
      <div class="shortcut-settings-body">
        ${rows}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  function closeDialog() {
    cleanupRecording();
    document.removeEventListener("keydown", escHandler, true);
    overlay.remove();
  }

  // Close on Escape (only when not recording a shortcut)
  function escHandler(e) {
    if (e.key === "Escape" && !activeKeyHandler) {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    }
  }
  document.addEventListener("keydown", escHandler, true);

  // Close on overlay click or close button
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay
    .querySelector(".close-dialog-btn")
    .addEventListener("click", closeDialog);

  // Rebind: click key button → enter recording mode
  overlay.querySelectorAll(".shortcut-key-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Cancel any existing recording
      cleanupRecording();
      const existingBtn = overlay.querySelector(".shortcut-key-btn.recording");
      if (existingBtn && existingBtn !== btn) {
        existingBtn.classList.remove("recording");
        const oldAction = existingBtn.closest(".shortcut-row").dataset.action;
        existingBtn.textContent =
          formatShortcutDisplay(shortcuts[oldAction]) || "\u2014";
      }

      btn.classList.add("recording");
      btn.textContent = "Press keys...";

      function onKeyDown(e) {
        e.preventDefault();
        e.stopPropagation();

        // Ignore lone modifier keys
        if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;

        // Escape cancels recording
        if (e.key === "Escape") {
          btn.classList.remove("recording");
          const actionId = btn.closest(".shortcut-row").dataset.action;
          btn.textContent =
            formatShortcutDisplay(shortcuts[actionId]) || "\u2014";
          cleanupRecording();
          return;
        }

        // Build Electron accelerator from the event
        const parts = [];
        if (e.metaKey) parts.push("CmdOrCtrl");
        if (e.ctrlKey && !e.metaKey) parts.push("Ctrl");
        if (e.shiftKey) parts.push("Shift");
        if (e.altKey) parts.push("Alt");

        const keyMap = {
          ArrowUp: "Up",
          ArrowDown: "Down",
          ArrowLeft: "Left",
          ArrowRight: "Right",
          " ": "Space",
          Backspace: "Backspace",
          Delete: "Delete",
          Enter: "Return",
          Tab: "Tab",
        };
        const key = keyMap[e.key] || e.key.toUpperCase();
        parts.push(key);

        const accelerator = parts.join("+");
        const actionId = btn.closest(".shortcut-row").dataset.action;

        btn.classList.remove("recording");
        btn.textContent = formatShortcutDisplay(accelerator);
        shortcuts[actionId] = accelerator;
        shortcutConfig = { ...shortcuts };

        window.api.setShortcut(actionId, accelerator);
        cleanupRecording();
      }

      activeKeyHandler = onKeyDown;
      document.addEventListener("keydown", onKeyDown, true);
    });
  });

  // Reset buttons
  overlay.querySelectorAll(".shortcut-reset-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".shortcut-row");
      const actionId = row.dataset.action;
      await window.api.resetShortcut(actionId);
      const defaultVal = await window.api.getDefaultShortcut(actionId);
      shortcuts[actionId] = defaultVal;
      shortcutConfig = { ...shortcuts };
      const keyBtn = row.querySelector(".shortcut-key-btn");
      keyBtn.textContent = formatShortcutDisplay(defaultVal) || "—";
    });
  });

  // Unbind: button to clear a shortcut
  overlay.querySelectorAll(".shortcut-key-btn").forEach((btn) => {
    btn.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const row = btn.closest(".shortcut-row");
      const actionId = row.dataset.action;
      await window.api.setShortcut(actionId, "");
      shortcuts[actionId] = "";
      shortcutConfig = { ...shortcuts };
      btn.textContent = "—";
    });
  });
}

export {
  showPoolSettings,
  openSlotTerminalPopup,
  showShortcutSettings,
  updatePoolHealthBadge,
  stopPoolSettingsPolling,
};
