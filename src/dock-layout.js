// Flexible docking panel system — recursive split tree with drag-and-drop tabs
// Each leaf node has a tab bar + content area. Tabs can be dragged between leaves
// or to edges to create new splits.

let _leafId = 0;

export function newLeafId() {
  return `leaf-${_leafId++}`;
}

export function createDefaultLayout(leftTabs, rightTabs) {
  return {
    type: "split",
    direction: "horizontal",
    children: [
      { type: "leaf", id: newLeafId(), tabs: leftTabs, activeTab: 0 },
      { type: "leaf", id: newLeafId(), tabs: rightTabs, activeTab: 0 },
    ],
    sizes: [50, 50],
  };
}

export class DockLayout {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.root = null;
    this.tabs = new Map(); // tabId → { id, type, label, closable, contentEl }
    this.callbacks = callbacks;
    this._dragTabId = null;
  }

  // --- Public API ---

  registerTab(id, { type, label, closable = true, contentEl }) {
    this.tabs.set(id, { id, type, label, closable, contentEl });
  }

  updateTabLabel(id, label) {
    const tab = this.tabs.get(id);
    if (tab) tab.label = label;
  }

  unregisterTab(id) {
    const leaf = this._removeTabFromTree(id);
    this.tabs.delete(id);
    this._cleanupAndPatch(leaf);
  }

  setLayout(layout) {
    this.root = layout;
    this._render();
  }

  getLayout() {
    return this.root ? JSON.parse(JSON.stringify(this.root)) : null;
  }

  addTab(tabId, leafId) {
    if (!leafId) leafId = this.getFirstLeafId();
    const leaf = this._findLeaf(leafId);
    if (!leaf) return;
    if (!leaf.tabs.includes(tabId)) leaf.tabs.push(tabId);
    leaf.activeTab = leaf.tabs.indexOf(tabId);
    this._patchLeaf(leaf);
  }

  removeTab(tabId) {
    const leaf = this._removeTabFromTree(tabId);
    this._cleanupAndPatch(leaf);
  }

  activateTab(tabId) {
    let targetLeaf = null;
    this._forEachLeaf((leaf) => {
      const idx = leaf.tabs.indexOf(tabId);
      if (idx !== -1) {
        leaf.activeTab = idx;
        targetLeaf = leaf;
        return true; // early exit — tab is in exactly one leaf
      }
    });
    if (!targetLeaf) return;

    // In-place update — avoid full DOM rebuild
    const leafEl = this.container.querySelector(
      `[data-leaf-id="${targetLeaf.id}"]`,
    );
    if (!leafEl) {
      this._render();
      return;
    }
    const tabList = leafEl.querySelector(".dock-tab-list");
    this._updateTabActive(tabList, targetLeaf.activeTab);
    this._showActiveContent(targetLeaf, leafEl);
    window.dispatchEvent(new Event("dock-resize"));
    if (this.callbacks.onTabActivate) this.callbacks.onTabActivate(tabId);
  }

  getTabLeafId(tabId) {
    let result = null;
    this._forEachLeaf((leaf) => {
      if (leaf.tabs.includes(tabId)) {
        result = leaf.id;
        return true; // early exit
      }
    });
    return result;
  }

  getActiveTabInLeaf(leafId) {
    const leaf = this._findLeaf(leafId);
    if (!leaf || leaf.tabs.length === 0) return null;
    return leaf.tabs[leaf.activeTab] || leaf.tabs[0];
  }

  getLeafTabInfo(leafId) {
    const leaf = this._findLeaf(leafId);
    if (!leaf) return null;
    return { tabs: [...leaf.tabs], activeTab: leaf.activeTab };
  }

  getAllTabIds() {
    const ids = [];
    this._forEachLeaf((leaf) => {
      ids.push(...leaf.tabs);
    });
    return ids;
  }

  getLeafIds() {
    const ids = [];
    this._forEachLeaf((leaf) => {
      ids.push(leaf.id);
    });
    return ids;
  }

  moveTabToSplit(tabId, direction) {
    const leafId = this.getTabLeafId(tabId);
    if (!leafId) return;
    this._handleDrop(tabId, leafId, direction);
  }

  cycleTabInLeaf(leafId, direction) {
    const leaf = this._findLeaf(leafId);
    if (!leaf || leaf.tabs.length < 2) return;
    const nextIdx =
      (leaf.activeTab + direction + leaf.tabs.length) % leaf.tabs.length;
    this.activateTab(leaf.tabs[nextIdx]);
  }

  destroy() {
    this._detachAllContent();
    this.container.innerHTML = "";
    this.root = null;
  }

  _detachAllContent() {
    this.tabs.forEach((tab) => {
      if (tab.contentEl?.parentElement) {
        tab.contentEl.parentElement.removeChild(tab.contentEl);
      }
    });
  }

  // --- Tree traversal ---

  // Returns true from fn to stop walking early
  _walk(node, fn) {
    if (!node) return false;
    if (fn(node)) return true;
    if (node.type === "split") {
      for (const c of node.children) {
        if (this._walk(c, fn)) return true;
      }
    }
    return false;
  }

  _forEachLeaf(fn) {
    this._walk(this.root, (n) => {
      if (n.type === "leaf") return fn(n);
    });
  }

  _findLeaf(id) {
    let result = null;
    this._forEachLeaf((l) => {
      if (l.id === id) {
        result = l;
        return true; // early exit
      }
    });
    return result;
  }

  getFirstLeafId() {
    let result = null;
    this._forEachLeaf((l) => {
      if (!result) {
        result = l.id;
        return true; // early exit
      }
    });
    return result;
  }

  // Remove a tab from its leaf and return the leaf (or null).
  _removeTabFromTree(tabId) {
    let found = null;
    this._forEachLeaf((leaf) => {
      const idx = leaf.tabs.indexOf(tabId);
      if (idx !== -1) {
        leaf.tabs.splice(idx, 1);
        if (leaf.activeTab >= leaf.tabs.length)
          leaf.activeTab = Math.max(0, leaf.tabs.length - 1);
        found = leaf;
        return true; // early exit — tab is in exactly one leaf
      }
    });
    return found;
  }

  // Remove empty leaves, collapse single-child splits
  _cleanup() {
    if (!this.root) return;
    this.root = this._cleanNode(this.root);
  }

  // Cleanup tree, then patch the leaf in-place if it survived — otherwise full rebuild.
  _cleanupAndPatch(leaf) {
    this._cleanup();
    if (leaf && leaf.tabs.length > 0 && this._findLeaf(leaf.id)) {
      this._patchLeaf(leaf);
    } else {
      this._render();
    }
  }

  _cleanNode(node) {
    if (node.type === "leaf") return node.tabs.length > 0 ? node : null;
    node.children = node.children
      .map((c) => this._cleanNode(c))
      .filter(Boolean);
    if (node.children.length !== node.sizes.length) {
      node.sizes = node.children.map(() => 100 / node.children.length);
    }
    if (node.children.length === 0) return null;
    if (node.children.length === 1) return node.children[0];
    return node;
  }

  // Replace a leaf with a split containing [newLeaf, originalLeaf] or vice versa
  _splitLeaf(targetLeafId, newLeaf, direction, position) {
    if (this.root.type === "leaf" && this.root.id === targetLeafId) {
      const first = position === "before" ? newLeaf : this.root;
      const second = position === "before" ? this.root : newLeaf;
      this.root = {
        type: "split",
        direction,
        children: [first, second],
        sizes: [50, 50],
      };
      return;
    }
    this._splitInTree(this.root, targetLeafId, newLeaf, direction, position);
  }

  _splitInTree(node, targetId, newLeaf, direction, position) {
    if (node.type !== "split") return false;
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.id === targetId) {
        if (node.direction === direction) {
          // Same direction split: insert as sibling (flatten)
          const insertIdx = position === "before" ? i : i + 1;
          node.children.splice(insertIdx, 0, newLeaf);
          node.sizes = node.children.map(() => 100 / node.children.length);
        } else {
          // Different direction: wrap in nested split
          const first = position === "before" ? newLeaf : child;
          const second = position === "before" ? child : newLeaf;
          node.children[i] = {
            type: "split",
            direction,
            children: [first, second],
            sizes: [50, 50],
          };
        }
        return true;
      }
      if (this._splitInTree(child, targetId, newLeaf, direction, position))
        return true;
    }
    return false;
  }

  // --- Drop handling ---

  _handleDrop(tabId, targetLeafId, zone) {
    this._removeTabFromTree(tabId);

    if (zone === "center") {
      const leaf = this._findLeaf(targetLeafId);
      if (leaf) {
        leaf.tabs.push(tabId);
        leaf.activeTab = leaf.tabs.length - 1;
      }
    } else {
      const newLeaf = {
        type: "leaf",
        id: newLeafId(),
        tabs: [tabId],
        activeTab: 0,
      };
      const direction =
        zone === "left" || zone === "right" ? "horizontal" : "vertical";
      const position = zone === "left" || zone === "top" ? "before" : "after";
      this._splitLeaf(targetLeafId, newLeaf, direction, position);
    }

    this._cleanup();
    this._render();
    if (this.callbacks.onLayoutChange) this.callbacks.onLayoutChange();
  }

  // --- Rendering ---

  _render() {
    // Save focused element before DOM rebuild — detaching content drops focus
    const activeEl = document.activeElement;
    const hadFocus =
      activeEl &&
      activeEl !== document.body &&
      this.container.contains(activeEl);

    this._detachAllContent();
    this.container.innerHTML = "";
    if (!this.root) return;
    this.container.appendChild(this._renderNode(this.root));

    // Dispatch synchronously — handlers use their own rAF to read layout after
    // the browser has recalculated flex sizes in the next frame.
    window.dispatchEvent(new Event("dock-resize"));

    // Restore focus — content elements are reattached, so the previously
    // focused element (e.g. xterm textarea) is back in the DOM
    if (hadFocus && this.container.contains(activeEl)) {
      activeEl.focus();
    }
  }

  _renderNode(node) {
    return node.type === "split"
      ? this._renderSplit(node)
      : this._renderLeaf(node);
  }

  _renderSplit(node) {
    const el = document.createElement("div");
    el.className = `dock-split dock-${node.direction}`;

    for (let i = 0; i < node.children.length; i++) {
      const wrapper = document.createElement("div");
      wrapper.className = "dock-split-child";
      wrapper.style.flexBasis = `${node.sizes[i]}%`;
      wrapper.appendChild(this._renderNode(node.children[i]));
      el.appendChild(wrapper);

      if (i < node.children.length - 1) {
        el.appendChild(this._createResizeHandle(node, i, el));
      }
    }
    return el;
  }

  // Populate a tab list element with tab buttons for the given leaf node.
  // Shared by _renderLeaf (full build) and _patchLeaf (incremental update).
  _populateTabList(tabList, node, leafEl) {
    tabList.innerHTML = "";

    for (let i = 0; i < node.tabs.length; i++) {
      const tabId = node.tabs[i];
      const tabInfo = this.tabs.get(tabId);
      if (!tabInfo) continue;

      const tab = document.createElement("div");
      tab.className = `dock-tab${i === node.activeTab ? " active" : ""}`;
      tab.dataset.tabId = tabId;
      tab.draggable = true;

      const labelSpan = document.createElement("span");
      labelSpan.className = "dock-tab-label";
      labelSpan.textContent = tabInfo.label;
      tab.appendChild(labelSpan);

      if (tabInfo.closable) {
        const closeBtn = document.createElement("span");
        closeBtn.className = "dock-tab-close";
        closeBtn.textContent = "\u2715";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.callbacks.onTabClose) this.callbacks.onTabClose(tabId);
        });
        tab.appendChild(closeBtn);
      }

      // Click → activate
      tab.addEventListener("click", () => {
        node.activeTab = i;
        this._showActiveContent(node, leafEl);
        this._updateTabActive(tabList, i);
        window.dispatchEvent(new Event("dock-resize"));
        if (this.callbacks.onTabActivate) this.callbacks.onTabActivate(tabId);
      });

      // Drag start
      tab.addEventListener("dragstart", (e) => {
        this._dragTabId = tabId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", tabId);
        tab.classList.add("dragging");
        requestAnimationFrame(() => this._showDropIndicators());
      });

      tab.addEventListener("dragend", () => {
        tab.classList.remove("dragging");
        this._hideDropIndicators();
        this._dragTabId = null;
      });

      tabList.appendChild(tab);
    }
  }

  // Update a single leaf's tab bar and content in-place (no full DOM rebuild).
  _patchLeaf(leafNode) {
    const leafEl = this.container.querySelector(
      `[data-leaf-id="${leafNode.id}"]`,
    );
    if (!leafEl) {
      this._render();
      return;
    }
    const tabList = leafEl.querySelector(".dock-tab-list");
    this._populateTabList(tabList, leafNode, leafEl);
    this._showActiveContent(leafNode, leafEl);
    window.dispatchEvent(new Event("dock-resize"));
  }

  _renderLeaf(node) {
    const el = document.createElement("div");
    el.className = "dock-leaf";
    el.dataset.leafId = node.id;

    // --- Tab bar ---
    const tabBar = document.createElement("div");
    tabBar.className = "dock-tab-bar";

    const tabList = document.createElement("div");
    tabList.className = "dock-tab-list";
    this._populateTabList(tabList, node, el);

    tabBar.appendChild(tabList);

    // "+" button
    const addBtn = document.createElement("button");
    addBtn.className = "dock-tab-add";
    addBtn.textContent = "+";
    addBtn.title = "New terminal";
    addBtn.addEventListener("click", () => {
      if (this.callbacks.onNewTerminal) this.callbacks.onNewTerminal(node.id);
    });
    tabBar.appendChild(addBtn);

    el.appendChild(tabBar);

    // --- Content area ---
    const contentArea = document.createElement("div");
    contentArea.className = "dock-content";
    el.appendChild(contentArea);

    // Drop indicator (absolute positioned over the leaf)
    const dropIndicator = document.createElement("div");
    dropIndicator.className = "dock-drop-indicator";
    el.appendChild(dropIndicator);

    // Show active tab content
    this._showActiveContent(node, el);

    // Wire drop handlers
    this._setupDropHandlers(el, node);

    return el;
  }

  _showActiveContent(node, leafEl) {
    const contentArea = leafEl.querySelector(".dock-content");
    while (contentArea.firstChild) {
      contentArea.removeChild(contentArea.firstChild);
    }
    const activeTabId = node.tabs[node.activeTab];
    if (!activeTabId) return;
    const tabInfo = this.tabs.get(activeTabId);
    if (!tabInfo?.contentEl) return;
    contentArea.appendChild(tabInfo.contentEl);
    tabInfo.contentEl.style.display = "";
  }

  _updateTabActive(tabList, activeIndex) {
    tabList.querySelectorAll(".dock-tab").forEach((tab, i) => {
      tab.classList.toggle("active", i === activeIndex);
    });
  }

  // --- Resize handles ---

  _createResizeHandle(splitNode, childIndex, splitEl) {
    const handle = document.createElement("div");
    handle.className = `dock-resize-handle dock-resize-${splitNode.direction}`;

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const isH = splitNode.direction === "horizontal";
      const startPos = isH ? e.clientX : e.clientY;
      const startSizes = [...splitNode.sizes];
      let resizePending = false;

      document.body.classList.add(isH ? "dock-resizing-h" : "dock-resizing-v");

      const onMove = (e) => {
        const pos = isH ? e.clientX : e.clientY;
        const rect = splitEl.getBoundingClientRect();
        const total = isH ? rect.width : rect.height;
        const handleSpace = (splitNode.children.length - 1) * 4;
        const available = total - handleSpace;
        if (available <= 0) return;

        const sumPct = startSizes[childIndex] + startSizes[childIndex + 1];
        const deltaPct = ((pos - startPos) / available) * sumPct;

        let a = startSizes[childIndex] + deltaPct;
        let b = startSizes[childIndex + 1] - deltaPct;
        const min = 5;
        if (a < min) {
          a = min;
          b = sumPct - min;
        }
        if (b < min) {
          b = min;
          a = sumPct - min;
        }

        splitNode.sizes[childIndex] = a;
        splitNode.sizes[childIndex + 1] = b;

        const children = splitEl.querySelectorAll(":scope > .dock-split-child");
        if (children[childIndex])
          children[childIndex].style.flexBasis = `${a}%`;
        if (children[childIndex + 1])
          children[childIndex + 1].style.flexBasis = `${b}%`;

        if (!resizePending) {
          resizePending = true;
          requestAnimationFrame(() => {
            resizePending = false;
            window.dispatchEvent(new Event("dock-resize"));
          });
        }
      };

      const onUp = () => {
        document.body.classList.remove("dock-resizing-h", "dock-resizing-v");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (this.callbacks.onLayoutChange) this.callbacks.onLayoutChange();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    return handle;
  }

  // --- Drop zone indicators ---

  _showDropIndicators() {
    this.container
      .querySelectorAll(".dock-leaf")
      .forEach((leaf) => leaf.classList.add("dock-drop-active"));
  }

  _hideDropIndicators() {
    this.container.querySelectorAll(".dock-leaf").forEach((leaf) => {
      leaf.classList.remove("dock-drop-active");
      const ind = leaf.querySelector(".dock-drop-indicator");
      if (ind) ind.className = "dock-drop-indicator";
    });
  }

  _getDropZone(e, leafEl) {
    const contentArea = leafEl.querySelector(".dock-content");
    const cr = contentArea.getBoundingClientRect();

    // Above content area (in tab bar) → center/stack
    if (e.clientY < cr.top) return "center";

    const x = (e.clientX - cr.left) / cr.width;
    const y = (e.clientY - cr.top) / cr.height;
    const edge = 0.25;

    if (y < edge) return "top";
    if (y > 1 - edge) return "bottom";
    if (x < edge) return "left";
    if (x > 1 - edge) return "right";
    return "center";
  }

  _setupDropHandlers(leafEl, leafNode) {
    const indicator = leafEl.querySelector(".dock-drop-indicator");

    leafEl.addEventListener("dragover", (e) => {
      if (!this._dragTabId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const zone = this._getDropZone(e, leafEl);
      indicator.className = `dock-drop-indicator visible dock-indicate-${zone}`;
    });

    leafEl.addEventListener("dragleave", (e) => {
      if (!leafEl.contains(e.relatedTarget)) {
        indicator.className = "dock-drop-indicator";
      }
    });

    leafEl.addEventListener("drop", (e) => {
      e.preventDefault();
      indicator.className = "dock-drop-indicator";
      if (!this._dragTabId) return;
      const zone = this._getDropZone(e, leafEl);
      // Don't no-op: dropping on center of same leaf just reactivates the tab
      this._handleDrop(this._dragTabId, leafNode.id, zone);
    });
  }
}
