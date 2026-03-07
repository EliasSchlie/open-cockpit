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
 * @returns {{ overlay: HTMLElement, close: () => void }}
 */
export function createOverlayDialog({
  html,
  id,
  escapeClose = true,
  closeSelector = ".snapshot-close",
  onClose,
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

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (escapeClose) {
      document.removeEventListener("keydown", escHandler, true);
    }
    overlay.remove();
    if (onClose) onClose();
  }

  // Store close for programmatic cleanup (e.g. dedup on next open)
  overlay._cleanup = close;

  function escHandler(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  if (escapeClose) {
    document.addEventListener("keydown", escHandler, true);
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
    const { overlay, close } = createOverlayDialog({
      html,
      escapeClose: false,
      onClose: () => resolve(false),
    });

    // Escape → cancel
    function escHandler(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(); // triggers onClose → resolve(false)
      }
    }
    document.addEventListener("keydown", escHandler, true);

    // Override close to also clean up our Escape handler
    const origClose = close;
    const wrappedClose = (result) => {
      document.removeEventListener("keydown", escHandler, true);
      if (result === true) {
        // Resolve true before removing overlay
        overlay.remove();
        resolve(true);
      } else {
        origClose(); // triggers onClose → resolve(false)
      }
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) wrappedClose(false);
    });

    if (cancelSelector) {
      const btn = overlay.querySelector(cancelSelector);
      if (btn) btn.addEventListener("click", () => wrappedClose(false));
    }

    const confirmBtn = overlay.querySelector(confirmSelector);
    if (confirmBtn)
      confirmBtn.addEventListener("click", () => wrappedClose(true));
  });
}
