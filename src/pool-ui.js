import {
  showNotification,
  STATUS_CLASSES,
  escapeHtml,
} from "./renderer-state.js";
import { STATUS, POOL_STATUS, UPDATE_STATUS } from "./session-statuses.js";
import { FitAddon } from "@xterm/addon-fit";
import {
  createTerminal,
  wireTerminalInput,
  popupTerminals,
  findTerminalEntry,
} from "./terminal-manager.js";
import { formatShortcutDisplay, COMMANDS } from "./command-palette.js";
import { createOverlayDialog } from "./overlay-dialog.js";

// --- Cross-module dependencies (set via initPoolUi) ---
let _actions = {};

/**
 * Initialize pool UI with dependencies from the main renderer module.
 */
export function initPoolUi(actions) {
  _actions = actions;

  // Wire up the settings button
  const poolSettingsBtn = document.getElementById("pool-settings-btn");
  poolSettingsBtn.addEventListener("click", () => showSettings());
}

// --- Module-local state ---
let poolSettingsInterval = null;
let shortcutLabelsBuilt = false;
const SHORTCUT_LABELS = {};

// Build shortcut labels lazily (COMMANDS isn't populated until after initCommandPalette)
function ensureShortcutLabels() {
  if (shortcutLabelsBuilt) return;
  // Don't cache if COMMANDS is still empty (initCommandPalette hasn't run yet)
  if (!COMMANDS.length) return;
  shortcutLabelsBuilt = true;
  for (const cmd of COMMANDS) {
    if (cmd.shortcutAction) SHORTCUT_LABELS[cmd.shortcutAction] = cmd.label;
  }
  // Actions only reachable via input events (no COMMANDS entry)
  SHORTCUT_LABELS["next-terminal-tab-alt"] = "Next Tab (Alt)";
  SHORTCUT_LABELS["prev-terminal-tab-alt"] = "Previous Tab (Alt)";
}

/**
 * Wrap a button click in loading state: sets text + disables, restores on error.
 * On success the button stays disabled (caller typically re-renders the whole dialog).
 * Returns the asyncFn result; re-throws on error after restoring the button.
 */
async function withButtonLoading(btn, loadingText, asyncFn) {
  const originalText = btn.textContent;
  btn.textContent = loadingText;
  btn.disabled = true;
  try {
    return await asyncFn();
  } catch (err) {
    btn.textContent = originalText;
    btn.disabled = false;
    throw err;
  }
}

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

  const label =
    slot.intentionHeading ||
    slot.sessionId?.slice(0, 8) ||
    `slot-${slot.index}`;

  const term = createTerminal();
  const fitAddon = new FitAddon();
  let resizeObserver = null;

  const { overlay, close } = createOverlayDialog({
    id: "slot-terminal-popup",
    escapeClose: false,
    closeSelector: ".slot-terminal-close",
    html: `
      <div class="slot-terminal-dialog">
        <div class="slot-terminal-header">
          <span class="slot-terminal-title">${escapeHtml(label)}</span>
          <button class="snapshot-close slot-terminal-close">\u2715</button>
        </div>
        <div class="slot-terminal-mount"></div>
      </div>
    `,
    onClose: () => {
      if (resizeObserver) resizeObserver.disconnect();
      popupTerminals.delete(slot.termId);
      const otherEntry = findTerminalEntry(slot.termId);
      if (otherEntry) {
        window.api.ptyResize(
          slot.termId,
          otherEntry.term.cols,
          otherEntry.term.rows,
        );
      } else {
        window.api.ptyDetach(slot.termId).catch(() => {});
      }
      term.dispose();
    },
  });

  const mountEl = overlay.querySelector(".slot-terminal-mount");

  term.loadAddon(fitAddon);
  term.open(mountEl);

  // Wire input to the PTY so the popup is interactive
  wireTerminalInput(term, slot.termId);

  // Register in popupTerminals so global data handlers can route data here.
  const popupEntry = { termId: slot.termId, term, fitAddon };
  popupTerminals.set(slot.termId, popupEntry);

  try {
    await window.api.ptyAttach(slot.termId);
  } catch (err) {
    showNotification(`Failed to attach: ${err.message}`);
    close();
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

  resizeObserver = new ResizeObserver(doFit);
  resizeObserver.observe(mountEl);
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
      ? `Settings — ${errors} slot${errors > 1 ? "s" : ""} in error`
      : "Settings";
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

// --- Unified Settings Dialog ---

const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "shortcuts", label: "Keyboard Shortcuts" },
  { id: "pool", label: "Pool" },
];

async function showSettings(initialTab = "general") {
  stopPoolSettingsPolling();

  // Fetch data for all sections
  const [
    health,
    shortcuts,
    defaults,
    version,
    pluginVersion,
    poolFlags,
    updateState,
    minFresh,
  ] = await Promise.all([
    window.api.poolHealth(),
    window.api.getShortcuts(),
    window.api.getDefaultShortcuts(),
    window.api.getAppVersion(),
    window.api.getPluginVersion(),
    window.api.poolGetFlags(),
    window.api.getUpdateState(),
    window.api.poolGetMinFresh(),
  ]);

  let keyHandler = null;
  let cleanupRecordingFn = null;
  let updateStatusCleanup = null;

  const { overlay, close } = createOverlayDialog({
    id: "unified-settings",
    escapeClose: false,
    closeSelector: ".settings-close-btn",
    html: `
      <div class="settings-dialog">
        <div class="settings-header">
          <span>Settings</span>
          <button class="close-dialog-btn settings-close-btn">✕</button>
        </div>
        <div class="settings-layout">
          <div class="settings-nav">
            ${SETTINGS_TABS.map(
              (tab) =>
                `<button class="settings-nav-item${tab.id === initialTab ? " active" : ""}" data-tab="${tab.id}">${tab.label}</button>`,
            ).join("")}
          </div>
          <div class="settings-content">
            ${renderGeneralTab(version, pluginVersion, updateState)}
            ${renderShortcutsTab(shortcuts, defaults)}
            ${renderPoolTab(health, poolFlags, minFresh)}
          </div>
        </div>
      </div>
    `,
    onClose: () => {
      window.api.setDialogOpen(false);
      stopPoolSettingsPolling();
      if (keyHandler) {
        document.removeEventListener("keydown", keyHandler, true);
      }
      if (cleanupRecordingFn) cleanupRecordingFn();
      if (updateStatusCleanup) updateStatusCleanup();
    },
  });

  window.api.setDialogOpen(true);

  // --- Tab switching ---
  function switchTab(tabId) {
    overlay.querySelectorAll(".settings-nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
    overlay.querySelectorAll(".settings-tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tab === tabId);
    });
  }

  switchTab(initialTab);

  overlay.querySelectorAll(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // --- Hierarchical keyboard navigation ---
  // Levels: "nav" (tab sidebar) → "content" (items in active tab) → "detail" (inside an item)
  const tabIds = SETTINGS_TABS.map((t) => t.id);
  let navLevel = "nav"; // "nav" | "content" | "detail"
  let contentIndex = 0;
  let detailIndex = 0;

  function getActiveTabId() {
    const active = overlay.querySelector(".settings-nav-item.active");
    return active ? active.dataset.tab : tabIds[0];
  }

  function cycleTab(delta) {
    const current = getActiveTabId();
    const idx = tabIds.indexOf(current);
    const next = (idx + delta + tabIds.length) % tabIds.length;
    switchTab(tabIds[next]);
    contentIndex = 0;
    detailIndex = 0;
    applyNavHighlight();
  }

  // Get navigable items in the active tab's content
  function getContentItems() {
    const tabId = getActiveTabId();
    const panel = overlay.querySelector(
      `.settings-tab-panel[data-tab="${tabId}"]`,
    );
    if (!panel) return [];
    if (tabId === "pool") {
      // Pool: slots list (as one block) + each button
      const items = [];
      const slotsList = panel.querySelector(".pool-slots-list");
      if (slotsList) items.push(slotsList);
      for (const btn of panel.querySelectorAll(
        ".pool-controls .offload-menu-btn",
      ))
        items.push(btn);
      // Also include pool-size input label
      const sizeLabel = panel.querySelector(".pool-size-label");
      if (sizeLabel) items.push(sizeLabel);
      return items;
    }
    if (tabId === "shortcuts") {
      const items = [];
      const searchInput = panel.querySelector(".shortcut-search");
      if (searchInput) items.push(searchInput);
      for (const row of panel.querySelectorAll(".shortcut-row")) {
        if (row.style.display !== "none") items.push(row);
      }
      return items;
    }
    if (tabId === "general") {
      const items = Array.from(panel.querySelectorAll(".settings-info-row"));
      for (const btn of panel.querySelectorAll(".offload-menu-btn"))
        items.push(btn);
      return items;
    }
    return [];
  }

  // Get detail items inside a content item (e.g. pool slot rows)
  function getDetailItems() {
    const items = getContentItems();
    const item = items[contentIndex];
    if (!item) return [];
    if (item.classList.contains("pool-slots-list")) {
      return Array.from(item.querySelectorAll(".pool-slot-row"));
    }
    return [];
  }

  function clearNavHighlight() {
    for (const el of overlay.querySelectorAll(".kb-selected"))
      el.classList.remove("kb-selected");
  }

  function applyNavHighlight() {
    clearNavHighlight();
    if (navLevel === "nav") {
      // Highlight active nav item
      const navItem = overlay.querySelector(".settings-nav-item.active");
      if (navItem) navItem.classList.add("kb-selected");
    } else if (navLevel === "content") {
      const items = getContentItems();
      contentIndex = Math.min(contentIndex, Math.max(0, items.length - 1));
      if (items[contentIndex]) {
        items[contentIndex].classList.add("kb-selected");
        items[contentIndex].scrollIntoView({ block: "nearest" });
      }
    } else if (navLevel === "detail") {
      const items = getDetailItems();
      detailIndex = Math.min(detailIndex, Math.max(0, items.length - 1));
      if (items[detailIndex]) {
        items[detailIndex].classList.add("kb-selected");
        items[detailIndex].scrollIntoView({ block: "nearest" });
      }
    }
  }

  applyNavHighlight();

  keyHandler = (e) => {
    if (document.getElementById("slot-terminal-popup")) return;
    if (overlay.querySelector(".shortcut-key-btn.recording")) return;

    if (overlay.querySelector("input:focus")) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        overlay.querySelector("input:focus").blur();
      }
      return;
    }

    const { key } = e;

    if (key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (navLevel === "detail") {
        navLevel = "content";
        applyNavHighlight();
      } else if (navLevel === "content") {
        navLevel = "nav";
        applyNavHighlight();
      } else {
        close();
      }
      return;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const delta = key === "ArrowDown" ? 1 : -1;
      if (navLevel === "nav") {
        cycleTab(delta);
      } else if (navLevel === "content") {
        const items = getContentItems();
        if (items.length > 0) {
          contentIndex = Math.max(
            0,
            Math.min(items.length - 1, contentIndex + delta),
          );
          applyNavHighlight();
        }
      } else if (navLevel === "detail") {
        const items = getDetailItems();
        if (items.length > 0) {
          detailIndex = Math.max(
            0,
            Math.min(items.length - 1, detailIndex + delta),
          );
          applyNavHighlight();
        }
      }
      return;
    }

    if (key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      if (navLevel === "nav") {
        navLevel = "content";
        contentIndex = 0;
        applyNavHighlight();
      } else if (navLevel === "content") {
        // Drill into item if it has detail items (e.g. pool slots list)
        const detailItems = getDetailItems();
        if (detailItems.length > 0) {
          navLevel = "detail";
          detailIndex = 0;
          applyNavHighlight();
        }
      }
      return;
    }

    if (key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      if (navLevel === "detail") {
        navLevel = "content";
        applyNavHighlight();
      } else if (navLevel === "content") {
        navLevel = "nav";
        applyNavHighlight();
      }
      return;
    }

    if (key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (navLevel === "content") {
        const items = getContentItems();
        const item = items[contentIndex];
        if (item) {
          // Focus input — either the item itself or a child input
          const input =
            item.tagName === "INPUT" ? item : item.querySelector("input");
          if (input) {
            input.focus();
            input.select();
          } else if (item.tagName === "BUTTON") {
            item.click();
          } else if (item.classList.contains("shortcut-row")) {
            const keyBtn = item.querySelector(".shortcut-key-btn");
            if (keyBtn) keyBtn.click();
          } else if (item.classList.contains("pool-slots-list")) {
            // Enter slots list = drill in
            navLevel = "detail";
            detailIndex = 0;
            applyNavHighlight();
          }
        }
      } else if (navLevel === "detail") {
        const items = getDetailItems();
        const item = items[detailIndex];
        if (item) item.click();
      } else if (navLevel === "nav") {
        navLevel = "content";
        contentIndex = 0;
        applyNavHighlight();
      }
      return;
    }
  };
  document.addEventListener("keydown", keyHandler, true);

  // --- Wire Pool tab ---
  wirePoolTab(overlay, health, close, applyNavHighlight);

  // --- Wire Shortcuts tab ---
  wireShortcutsTab(overlay, shortcuts, defaults);

  // --- Wire General tab (update status listener) ---
  updateStatusCleanup = wireGeneralUpdates(overlay);
}

// --- General tab ---
function renderGeneralTab(version, pluginVersion, updateState) {
  const pluginMismatch = window.api.isPluginVersionMismatch(
    pluginVersion,
    version,
  );
  return `
    <div class="settings-tab-panel" data-tab="general">
      <div class="settings-section">
        <div class="settings-section-title">About</div>
        <div class="settings-info-row">
          <span class="settings-info-label">App Version</span>
          <span class="settings-info-value">${escapeHtml(version)}</span>
        </div>
        <div class="settings-info-row">
          <span class="settings-info-label">Plugin Version</span>
          <span class="settings-info-value${pluginMismatch ? " plugin-version-mismatch" : ""}">${escapeHtml(pluginVersion)}${pluginMismatch ? " ⚠" : ""}</span>
        </div>
        <div class="settings-info-row">
          <span class="settings-info-label">App</span>
          <span class="settings-info-value">Open Cockpit</span>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-info-row update-status-row">
          <span class="settings-info-label">Status</span>
          <span class="settings-info-value update-status-text">${updateStatusText(updateState)}</span>
        </div>
        <div class="update-progress-bar" style="display:${updateState.status === UPDATE_STATUS.DOWNLOADING ? "block" : "none"}">
          <div class="update-progress-fill" style="width:${updateState.progress ? Math.round(updateState.progress.percent) : 0}%"></div>
        </div>
        <div class="update-actions">
          ${updateActionButtonHtml(updateState)}
        </div>
      </div>
    </div>
  `;
}

// Find actions sharing the same accelerator (for conflict warnings)
function findShortcutConflicts(shortcuts, accelerator, excludeAction) {
  if (!accelerator) return [];
  const norm = accelerator.toLowerCase();
  const conflicts = [];
  for (const [id, val] of Object.entries(shortcuts)) {
    if (id !== excludeAction && val && val.toLowerCase() === norm) {
      conflicts.push(SHORTCUT_LABELS[id] || id);
    }
  }
  return conflicts;
}

// --- Shortcuts tab ---
function renderShortcutsTab(shortcuts, defaults) {
  ensureShortcutLabels();
  const actionIds = Object.keys(SHORTCUT_LABELS);

  const rows = actionIds
    .map((id) => {
      const label = SHORTCUT_LABELS[id];
      const current = shortcuts[id] || "";
      const display = formatShortcutDisplay(current) || "—";
      const isCustom = defaults && current !== (defaults[id] || "");
      const conflicts = findShortcutConflicts(shortcuts, current, id);
      const conflictHtml = conflicts.length
        ? `<div class="shortcut-conflict">Also bound to: ${conflicts.join(", ")}</div>`
        : "";
      return `<div class="shortcut-row${isCustom ? " custom" : ""}" data-action="${id}">
        <span class="shortcut-label">${label}</span>
        <button class="shortcut-key-btn" title="Click to rebind">${display}</button>
        <button class="shortcut-reset-btn" title="Reset to default"${isCustom ? "" : ' style="visibility:hidden"'}>↺</button>
        ${conflictHtml}
      </div>`;
    })
    .join("");

  return `
    <div class="settings-tab-panel" data-tab="shortcuts">
      <div class="settings-section">
        <div class="settings-section-subtitle">Click a shortcut to rebind. Right-click to unbind. Press Escape to cancel.</div>
        <input class="shortcut-search" type="text" placeholder="Search shortcuts…" />
        <div class="shortcut-settings-body">
          ${rows}
        </div>
      </div>
    </div>
  `;
}

function wireShortcutsTab(overlay, shortcuts, defaults) {
  let activeKeyHandler = null;

  function cleanupRecording() {
    if (activeKeyHandler) {
      document.removeEventListener("keydown", activeKeyHandler, true);
      activeKeyHandler = null;
    }
    // Clear any conflict warnings
    overlay.querySelectorAll(".shortcut-conflict").forEach((el) => el.remove());
  }

  function updateResetBtn(row, actionId, currentAccel) {
    const resetBtn = row.querySelector(".shortcut-reset-btn");
    if (!resetBtn || !defaults) return;
    const isCustom = currentAccel !== (defaults[actionId] || "");
    resetBtn.style.visibility = isCustom ? "" : "hidden";
    row.classList.toggle("custom", isCustom);
  }

  // Store cleanup for dialog close
  cleanupRecordingFn = cleanupRecording;

  function showConflictWarning(row, conflicts) {
    row.querySelector(".shortcut-conflict")?.remove();
    if (conflicts.length === 0) return;
    const warn = document.createElement("div");
    warn.className = "shortcut-conflict";
    warn.textContent = `Also bound to: ${conflicts.join(", ")}`;
    row.appendChild(warn);
  }

  // --- Search filtering ---
  const searchInput = overlay.querySelector(".shortcut-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.toLowerCase().trim();
      overlay.querySelectorAll(".shortcut-row").forEach((row) => {
        const label =
          row.querySelector(".shortcut-label")?.textContent.toLowerCase() || "";
        const key =
          row.querySelector(".shortcut-key-btn")?.textContent.toLowerCase() ||
          "";
        row.style.display =
          !query || label.includes(query) || key.includes(query) ? "" : "none";
      });
    });
  }

  overlay.querySelectorAll(".shortcut-key-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
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

        if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;

        if (e.key === "Escape") {
          btn.classList.remove("recording");
          const actionId = btn.closest(".shortcut-row").dataset.action;
          btn.textContent =
            formatShortcutDisplay(shortcuts[actionId]) || "\u2014";
          cleanupRecording();
          return;
        }

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

        const row = btn.closest(".shortcut-row");

        // Show conflict warning if another action uses the same binding
        const conflicts = findShortcutConflicts(
          shortcuts,
          accelerator,
          actionId,
        );
        showConflictWarning(row, conflicts);
        updateResetBtn(row, actionId, accelerator);

        window.api.setShortcut(actionId, accelerator);
        cleanupRecording();
      }

      activeKeyHandler = onKeyDown;
      document.addEventListener("keydown", onKeyDown, true);
    });

    btn.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      const row = btn.closest(".shortcut-row");
      const actionId = row.dataset.action;
      await window.api.setShortcut(actionId, "");
      shortcuts[actionId] = "";
      btn.textContent = "—";
      row.querySelector(".shortcut-conflict")?.remove();
      updateResetBtn(row, actionId, "");
    });
  });

  overlay.querySelectorAll(".shortcut-reset-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".shortcut-row");
      const actionId = row.dataset.action;
      await window.api.resetShortcut(actionId);
      const defaultVal = await window.api.getDefaultShortcut(actionId);
      shortcuts[actionId] = defaultVal;
      const keyBtn = row.querySelector(".shortcut-key-btn");
      keyBtn.textContent = formatShortcutDisplay(defaultVal) || "—";
      // Update conflict warning and reset button
      const conflicts = findShortcutConflicts(shortcuts, defaultVal, actionId);
      showConflictWarning(row, conflicts);
      updateResetBtn(row, actionId, defaultVal);
    });
  });
}

// --- Updates tab ---

function updateStatusText(state) {
  switch (state.status) {
    case UPDATE_STATUS.IDLE:
      return "Not checked yet";
    case UPDATE_STATUS.CHECKING:
      return "Checking for updates…";
    case UPDATE_STATUS.UP_TO_DATE:
      return "Up to date";
    case UPDATE_STATUS.AVAILABLE:
      return `Version ${state.version} available`;
    case UPDATE_STATUS.DOWNLOADING: {
      const pct = state.progress
        ? `${Math.round(state.progress.percent)}%`
        : "…";
      return `Downloading update… ${pct}`;
    }
    case UPDATE_STATUS.DOWNLOADED:
      return `Version ${state.version} ready to install`;
    case UPDATE_STATUS.ERROR:
      return `Error: ${state.error || "Unknown error"}`;
    default:
      return state.status;
  }
}

function updateActionButtonHtml(state) {
  switch (state.status) {
    case UPDATE_STATUS.IDLE:
    case UPDATE_STATUS.UP_TO_DATE:
    case UPDATE_STATUS.ERROR:
      return '<button class="offload-menu-btn update-check-btn">Check for Updates</button>';
    case UPDATE_STATUS.CHECKING:
      return '<button class="offload-menu-btn update-check-btn" disabled>Checking…</button>';
    case UPDATE_STATUS.AVAILABLE:
      return `<button class="offload-menu-btn offload-menu-load update-download-btn">Download v${escapeHtml(state.version)}</button>`;
    case UPDATE_STATUS.DOWNLOADING:
      return '<button class="offload-menu-btn update-download-btn" disabled>Downloading…</button>';
    case UPDATE_STATUS.DOWNLOADED:
      return `<button class="offload-menu-btn offload-menu-load update-install-btn">Restart &amp; Update</button>`;
    default:
      return '<button class="offload-menu-btn update-check-btn">Check for Updates</button>';
  }
}

function wireGeneralUpdates(overlay) {
  const panel = overlay.querySelector(
    '.settings-tab-panel[data-tab="general"]',
  );
  if (!panel) return () => {};

  let lastRenderedStatus = null;

  function updateUI(state) {
    const statusText = panel.querySelector(".update-status-text");
    if (statusText) statusText.textContent = updateStatusText(state);

    const progressBar = panel.querySelector(".update-progress-bar");
    const progressFill = panel.querySelector(".update-progress-fill");
    if (progressBar && progressFill) {
      progressBar.style.display =
        state.status === UPDATE_STATUS.DOWNLOADING ? "block" : "none";
      progressFill.style.width = `${state.progress ? Math.round(state.progress.percent) : 0}%`;
    }

    // Only re-render buttons when the status phase changes (not on every progress tick)
    if (state.status !== lastRenderedStatus) {
      lastRenderedStatus = state.status;
      const actionsEl = panel.querySelector(".update-actions");
      if (actionsEl) {
        actionsEl.innerHTML = updateActionButtonHtml(state);
        wireActionButtons();
      }
    }
  }

  function wireActionButtons() {
    const checkBtn = panel.querySelector(".update-check-btn");
    if (checkBtn) {
      checkBtn.addEventListener("click", async () => {
        try {
          await withButtonLoading(checkBtn, "Checking…", () =>
            window.api.checkForUpdates(),
          );
        } catch (err) {
          showNotification(`Update check failed: ${err.message}`);
        }
      });
    }

    const downloadBtn = panel.querySelector(".update-download-btn");
    if (downloadBtn && !downloadBtn.disabled) {
      downloadBtn.addEventListener("click", async () => {
        try {
          await withButtonLoading(downloadBtn, "Downloading…", () =>
            window.api.downloadUpdate(),
          );
        } catch (err) {
          showNotification(`Download failed: ${err.message}`);
          const state = await window.api.getUpdateState();
          updateUI(state);
        }
      });
    }

    const installBtn = panel.querySelector(".update-install-btn");
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        try {
          await withButtonLoading(installBtn, "Restarting…", () =>
            window.api.installUpdate(),
          );
        } catch (err) {
          showNotification(`Install failed: ${err.message}`);
        }
      });
    }
  }

  wireActionButtons();

  // Listen for live status updates from main process
  const handler = (state) => {
    // Guard: ignore events after overlay is destroyed
    if (!document.getElementById("unified-settings")) return;
    updateUI(state);
  };
  window.api.onUpdateStatusChanged(handler);

  // Return cleanup — remove the IPC listener to prevent accumulation
  return () => {
    window.api.offUpdateStatusChanged(handler);
  };
}

// --- Pool tab ---
function renderPoolTab(health, flags, minFresh) {
  const slotsHtml = renderPoolSlotsHtml(health);
  const countsHtml = renderPoolCountsHtml(health);
  const escapedFlags = escapeHtml(flags || "");
  const minFreshVal = typeof minFresh === "number" ? minFresh : 1;

  const flagsHtml = `
    <div class="pool-flags-row">
      <label class="pool-flags-label">Session flags:</label>
      <input type="text" class="pool-flags-input" value="${escapedFlags}"
        placeholder="--dangerously-skip-permissions"
        spellcheck="false">
    </div>`;

  return `
    <div class="settings-tab-panel" data-tab="pool">
      <div class="settings-section">
        <div class="pool-health-summary">${countsHtml}</div>
        ${
          health.initialized
            ? `
          <div class="pool-slots-list">${slotsHtml}</div>
          ${flagsHtml}
          <div class="pool-controls">
            <label class="pool-size-label">
              Pool size:
              <input type="number" class="pool-size-input" value="${health.poolSize}" min="1" max="20">
            </label>
            <label class="pool-size-label">
              Min fresh:
              <input type="number" class="pool-min-fresh-input" value="${minFreshVal}" min="0" max="10">
            </label>
            <button class="offload-menu-btn pool-resize-btn">Resize</button>
            <button class="offload-menu-btn pool-reload-btn">Reload Sessions</button>
            <button class="offload-menu-btn pool-clean-btn">Clean Idle</button>
            <button class="offload-menu-btn pool-destroy-btn">Destroy</button>
            <button class="offload-menu-btn pool-reinit-btn">Reinitialize</button>
          </div>
        `
            : `
          ${flagsHtml}
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
}

function wirePoolTab(overlay, health, closeDialog, applyNavHighlight) {
  // Poll for health updates while pool tab is active
  poolSettingsInterval = setInterval(async () => {
    const settingsEl = document.getElementById("unified-settings");
    if (!settingsEl) {
      stopPoolSettingsPolling();
      return;
    }
    // Skip polling when pool tab isn't visible
    const poolPanel = settingsEl.querySelector(
      '.settings-tab-panel[data-tab="pool"]',
    );
    if (!poolPanel || !poolPanel.classList.contains("active")) return;
    try {
      const h = await window.api.poolHealth();
      const summaryEl = overlay.querySelector(".pool-health-summary");
      if (summaryEl) summaryEl.innerHTML = renderPoolCountsHtml(h);
      const slotsEl = overlay.querySelector(".pool-slots-list");
      if (slotsEl) {
        slotsEl.innerHTML = renderPoolSlotsHtml(h);
        applyNavHighlight();
      }
    } catch {
      // Ignore transient errors
    }
  }, 3000);

  // Slot row click → open terminal popup
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

  // Flags input — save on blur or Enter
  const flagsInput = overlay.querySelector(".pool-flags-input");
  if (flagsInput) {
    let flagsSaveTimeout = null;
    const saveFlags = () => {
      clearTimeout(flagsSaveTimeout);
      window.api.poolSetFlags(flagsInput.value);
    };
    flagsInput.addEventListener("blur", saveFlags);
    flagsInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveFlags();
        showNotification("Session flags saved");
      }
      // Stop propagation so keyboard nav doesn't interfere with typing
      e.stopPropagation();
    });
    // Also auto-save after typing stops
    flagsInput.addEventListener("input", () => {
      clearTimeout(flagsSaveTimeout);
      flagsSaveTimeout = setTimeout(saveFlags, 1000);
    });
  }

  // Min fresh slots input — save on change
  const minFreshInput = overlay.querySelector(".pool-min-fresh-input");
  if (minFreshInput) {
    const saveMinFresh = () => {
      const val = parseInt(minFreshInput.value, 10);
      if (isNaN(val) || val < 0 || val > 10) return;
      window.api.poolSetMinFresh(val);
    };
    minFreshInput.addEventListener("blur", saveMinFresh);
    minFreshInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveMinFresh();
        showNotification("Min fresh slots saved");
      }
      e.stopPropagation();
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
      try {
        await withButtonLoading(initBtn, "Initializing...", () =>
          window.api.poolInit(size),
        );
        showNotification(`Pool initialized (${size} slots)`);
        await _actions.loadSessions();
        showSettings("pool");
      } catch (err) {
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
      try {
        await withButtonLoading(resizeBtn, "Resizing...", () =>
          window.api.poolResize(newSize),
        );
        showNotification(`Pool resized to ${newSize} slots`);
        await _actions.loadSessions();
        showSettings("pool");
      } catch (err) {
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Reload button
  const reloadBtn = overlay.querySelector(".pool-reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", async () => {
      closeDialog();
      await _actions.loadDirColors();
      await _actions.loadSessions();
      showNotification("Sessions reloaded");
    });
  }

  // Clean idle button
  const cleanBtn = overlay.querySelector(".pool-clean-btn");
  if (cleanBtn) {
    cleanBtn.addEventListener("click", async () => {
      try {
        const cleaned = await withButtonLoading(cleanBtn, "Cleaning...", () =>
          window.api.poolClean(),
        );
        showNotification(
          `Cleaned ${cleaned} idle session${cleaned !== 1 ? "s" : ""}`,
        );
        await _actions.loadSessions();
        showSettings("pool");
      } catch (err) {
        showNotification(`Error: ${err.message}`);
      }
    });
  }

  // Destroy button
  const destroyBtn = overlay.querySelector(".pool-destroy-btn");
  if (destroyBtn) {
    destroyBtn.addEventListener("click", async () => {
      try {
        await withButtonLoading(destroyBtn, "Destroying...", () =>
          window.api.poolDestroy(),
        );
        showNotification("Pool destroyed");
        await _actions.loadSessions();
        showSettings("pool");
      } catch (err) {
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
      try {
        await withButtonLoading(reinitBtn, "Reinitializing...", () =>
          window.api.poolDestroy(),
        );
      } catch (err) {
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
      showSettings("pool");
    });
  }
}

export {
  showSettings,
  openSlotTerminalPopup,
  updatePoolHealthBadge,
  stopPoolSettingsPolling,
};
