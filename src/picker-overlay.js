// Shared picker overlay: reusable open/close, keyboard nav, click-outside logic.
// Used by command-palette.js and session-search.js.

/**
 * Create a picker overlay controller.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.overlayEl  - The full-screen backdrop element
 * @param {HTMLInputElement} opts.inputEl - The search/filter input
 * @param {HTMLElement} opts.listEl     - The scrollable list container
 * @param {string} [opts.itemClass='overlay-picker-item'] - CSS class on selectable items (for querySelectorAll)
 * @param {function} opts.onInput      - Called with (query) when input changes
 * @param {function} opts.onSelect     - Called with (selectedIndex) on Enter or click
 * @param {function} opts.onOpen       - Called after overlay becomes visible
 * @param {function} opts.onClose      - Called after overlay is hidden
 * @param {function} opts.getItemCount - Returns current number of selectable items
 */
export function createPickerOverlay({
  overlayEl,
  inputEl,
  listEl,
  itemClass = "overlay-picker-item",
  onInput,
  onSelect,
  onOpen,
  onClose,
  getItemCount,
}) {
  let selectedIndex = 0;

  function open() {
    overlayEl.classList.add("visible");
    inputEl.value = "";
    selectedIndex = 0;
    window.api?.setDialogOpen?.(true);
    onOpen?.();
    inputEl.focus();
  }

  function close() {
    overlayEl.classList.remove("visible");
    inputEl.value = "";
    window.api?.setDialogOpen?.(false);
    onClose?.();
  }

  function toggle() {
    if (overlayEl.classList.contains("visible")) {
      close();
    } else {
      open();
    }
  }

  function getSelectedIndex() {
    return selectedIndex;
  }

  function setSelectedIndex(i) {
    selectedIndex = i;
  }

  function updateSelection(newIndex) {
    const items = listEl.querySelectorAll(`.${itemClass}`);
    if (items[selectedIndex]) items[selectedIndex].classList.remove("selected");
    selectedIndex = newIndex;
    if (items[selectedIndex]) {
      items[selectedIndex].classList.add("selected");
      items[selectedIndex].scrollIntoView({ block: "nearest" });
    }
  }

  // --- Event wiring ---

  inputEl.addEventListener("input", () => {
    selectedIndex = 0;
    onInput(inputEl.value);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const count = getItemCount();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      updateSelection(Math.min(selectedIndex + 1, count - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      updateSelection(Math.max(selectedIndex - 1, 0));
      return;
    }
    if (e.key === "Enter" && count > 0) {
      e.preventDefault();
      onSelect(selectedIndex);
      return;
    }
  });

  // Click outside dialog to close
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) close();
  });

  return {
    open,
    close,
    toggle,
    getSelectedIndex,
    setSelectedIndex,
    updateSelection,
  };
}
