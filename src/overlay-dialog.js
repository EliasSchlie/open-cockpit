// Shared overlay dialog helper — eliminates boilerplate for overlay creation,
// Escape handling, click-outside-to-close, and close button wiring.

/**
 * Create an overlay dialog with standard close behaviors.
 *
 * @param {Object} options
 * @param {string} options.html — innerHTML for the overlay
 * @param {string} [options.id] — optional id for deduplication (removes existing)
 * @param {boolean} [options.escapeClose=true] — close on Escape key
 * @param {string} [options.closeSelector=".snapshot-close"] — close button CSS selector
 * @param {Function} [options.onClose] — called when dialog closes (via any method)
 * @param {Function} [options.onKeydown] — custom keydown handler (receives event + close fn).
 *   When provided, replaces the built-in Escape handler entirely.
 * @returns {{ overlay: HTMLElement, close: () => void }}
 */
export function createOverlayDialog({
  html,
  id,
  escapeClose = true,
  closeSelector = ".snapshot-close",
  onClose,
  onKeydown,
}) {
  if (id) {
    const existing = document.getElementById(id);
    if (existing) {
      if (existing._cleanup) existing._cleanup();
      else existing.remove();
    }
  }

  const overlay = document.createElement("div");
  overlay.className = "offload-menu-overlay";
  if (id) overlay.id = id;
  overlay.innerHTML = html;

  document.body.appendChild(overlay);

  const hasKeyHandler = onKeydown || escapeClose;

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (hasKeyHandler) {
      document.removeEventListener("keydown", keyHandler, true);
    }
    overlay.remove();
    if (onClose) onClose();
  }

  // Store close for programmatic cleanup (e.g. dedup on next open)
  overlay._cleanup = close;

  function keyHandler(e) {
    if (onKeydown) {
      onKeydown(e, close);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  if (hasKeyHandler) {
    document.addEventListener("keydown", keyHandler, true);
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  if (closeSelector) {
    const closeBtn = overlay.querySelector(closeSelector);
    if (closeBtn) closeBtn.addEventListener("click", close);
  }

  return { overlay, close };
}

/**
 * Show a confirmation dialog. Returns Promise<boolean>.
 *
 * @param {Object} options
 * @param {string} options.html — innerHTML for the overlay
 * @param {string} [options.confirmSelector='[data-action="confirm"]']
 * @param {string} [options.cancelSelector='[data-action="cancel"]']
 * @returns {Promise<boolean>}
 */
export function showConfirmDialog({
  html,
  confirmSelector = '[data-action="confirm"]',
  cancelSelector = '[data-action="cancel"]',
}) {
  return new Promise((resolve) => {
    let resolved = false;

    function finish(result) {
      if (resolved) return;
      resolved = true;
      if (result) {
        // Bypass onClose (which resolves false) — detach overlay directly
        // close() still runs for cleanup (keyHandler removal) but onClose
        // won't double-resolve because of the `resolved` guard
        resolve(true);
      }
      close();
    }

    const { overlay, close } = createOverlayDialog({
      html,
      escapeClose: false,
      onClose: () => {
        if (!resolved) resolve(false);
      },
      onKeydown(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === "Tab" && buttons.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          const idx = buttons.indexOf(document.activeElement);
          const next = e.shiftKey
            ? (idx - 1 + buttons.length) % buttons.length
            : (idx + 1) % buttons.length;
          buttons[next].focus();
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(document.activeElement !== cancelBtn);
        }
      },
    });

    const confirmBtn = overlay.querySelector(confirmSelector);
    const cancelBtn = cancelSelector
      ? overlay.querySelector(cancelSelector)
      : null;
    const buttons = [confirmBtn, cancelBtn].filter(Boolean);

    // Auto-focus confirm button (default action on Enter)
    if (confirmBtn) confirmBtn.focus();

    if (cancelBtn) cancelBtn.addEventListener("click", () => finish(false));

    if (confirmBtn) confirmBtn.addEventListener("click", () => finish(true));
  });
}
