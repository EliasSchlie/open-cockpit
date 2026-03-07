import { describe, it, expect, beforeEach } from "vitest";

// DockLayout uses DOM APIs for rendering, but the tree/tab/focus logic can be
// tested by providing a minimal stub container and skipping visual assertions.
// We import the class source directly and mock `_render` to avoid DOM deps.

import {
  DockLayout,
  newLeafId,
  createDefaultLayout,
} from "../src/dock-layout.js";

function createMockDock() {
  // Minimal container stub — DockLayout only uses container for querySelector
  // during rendering, which we bypass by stubbing _render.
  const container = {
    innerHTML: "",
    appendChild: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
  };
  const dock = new DockLayout(container, {});
  // Stub rendering to avoid DOM operations
  dock._render = () => {};
  dock._patchLeaf = () => {};
  return dock;
}

function twoLeafLayout() {
  return {
    type: "split",
    direction: "horizontal",
    children: [
      { type: "leaf", id: "leaf-a", tabs: ["tab-1", "tab-2"], activeTab: 0 },
      { type: "leaf", id: "leaf-b", tabs: ["tab-3"], activeTab: 0 },
    ],
    sizes: [50, 50],
  };
}

describe("DockLayout", () => {
  let dock;

  beforeEach(() => {
    dock = createMockDock();
  });

  // --- Tab management ---

  describe("registerTab / unregisterTab", () => {
    it("registers and retrieves tabs", () => {
      dock.registerTab("t1", { type: "terminal", label: "T1", contentEl: {} });
      expect(dock.tabs.has("t1")).toBe(true);
      expect(dock.tabs.get("t1").label).toBe("T1");
    });

    it("unregisterTab removes tab from tree and registry", () => {
      dock.registerTab("t1", { type: "terminal", label: "T1", contentEl: {} });
      dock.setLayout({
        type: "leaf",
        id: "leaf-a",
        tabs: ["t1"],
        activeTab: 0,
      });
      dock.unregisterTab("t1");
      expect(dock.tabs.has("t1")).toBe(false);
    });
  });

  describe("addTab", () => {
    it("adds tab to specified leaf", () => {
      dock.registerTab("t1", { type: "terminal", label: "T1", contentEl: {} });
      dock.registerTab("t2", { type: "terminal", label: "T2", contentEl: {} });
      dock.setLayout({
        type: "leaf",
        id: "leaf-a",
        tabs: ["t1"],
        activeTab: 0,
      });

      dock.addTab("t2", "leaf-a");
      const info = dock.getLeafTabInfo("leaf-a");
      expect(info.tabs).toEqual(["t1", "t2"]);
      expect(info.activeTab).toBe(1); // newly added tab is activated
    });

    it("does not duplicate tab if already in leaf", () => {
      dock.registerTab("t1", { type: "terminal", label: "T1", contentEl: {} });
      dock.setLayout({
        type: "leaf",
        id: "leaf-a",
        tabs: ["t1"],
        activeTab: 0,
      });

      dock.addTab("t1", "leaf-a");
      expect(dock.getLeafTabInfo("leaf-a").tabs).toEqual(["t1"]);
    });

    it("sets lastFocusedLeafId", () => {
      dock.registerTab("t1", { type: "terminal", label: "T1", contentEl: {} });
      dock.setLayout(twoLeafLayout());

      dock.addTab("t1", "leaf-b");
      expect(dock.lastFocusedLeafId).toBe("leaf-b");
    });
  });

  // --- Tab activation ---

  describe("activateTab", () => {
    it("sets activeTab index in the correct leaf", () => {
      dock.setLayout(twoLeafLayout());

      dock.activateTab("tab-2");
      expect(dock.getLeafTabInfo("leaf-a").activeTab).toBe(1);
    });

    it("sets lastFocusedLeafId to the activated tab's leaf", () => {
      dock.setLayout(twoLeafLayout());

      dock.activateTab("tab-3");
      expect(dock.lastFocusedLeafId).toBe("leaf-b");

      dock.activateTab("tab-1");
      expect(dock.lastFocusedLeafId).toBe("leaf-a");
    });

    it("does nothing for unknown tab", () => {
      dock.setLayout(twoLeafLayout());
      dock.activateTab("nonexistent");
      expect(dock.lastFocusedLeafId).toBeNull();
    });
  });

  // --- Tab removal ---

  describe("removeTab", () => {
    it("removes tab and adjusts activeTab", () => {
      dock.setLayout({
        type: "leaf",
        id: "leaf-a",
        tabs: ["t1", "t2", "t3"],
        activeTab: 2,
      });

      dock.removeTab("t3");
      const info = dock.getLeafTabInfo("leaf-a");
      expect(info.tabs).toEqual(["t1", "t2"]);
      expect(info.activeTab).toBe(1); // clamped to last tab
    });

    it("removes leaf when last tab is removed", () => {
      dock.setLayout(twoLeafLayout());
      dock.removeTab("tab-3");
      // leaf-b should be cleaned up, leaving only leaf-a
      expect(dock.getLeafIds()).toEqual(["leaf-a"]);
    });
  });

  // --- Leaf queries ---

  describe("getLeafIds", () => {
    it("returns all leaf IDs in tree order", () => {
      dock.setLayout(twoLeafLayout());
      expect(dock.getLeafIds()).toEqual(["leaf-a", "leaf-b"]);
    });

    it("returns empty array for null root", () => {
      expect(dock.getLeafIds()).toEqual([]);
    });
  });

  describe("getAllTabIds", () => {
    it("returns all tab IDs across all leaves", () => {
      dock.setLayout(twoLeafLayout());
      expect(dock.getAllTabIds()).toEqual(["tab-1", "tab-2", "tab-3"]);
    });
  });

  describe("getTabLeafId", () => {
    it("returns the leaf containing the tab", () => {
      dock.setLayout(twoLeafLayout());
      expect(dock.getTabLeafId("tab-1")).toBe("leaf-a");
      expect(dock.getTabLeafId("tab-3")).toBe("leaf-b");
    });

    it("returns null for unknown tab", () => {
      dock.setLayout(twoLeafLayout());
      expect(dock.getTabLeafId("nope")).toBeNull();
    });
  });

  describe("getActiveTabInLeaf", () => {
    it("returns the active tab ID", () => {
      dock.setLayout(twoLeafLayout());
      expect(dock.getActiveTabInLeaf("leaf-a")).toBe("tab-1");
    });

    it("returns null for unknown leaf", () => {
      dock.setLayout(twoLeafLayout());
      expect(dock.getActiveTabInLeaf("nope")).toBeNull();
    });
  });

  describe("getLeafTabInfo", () => {
    it("returns tabs and activeTab for a leaf", () => {
      dock.setLayout(twoLeafLayout());
      const info = dock.getLeafTabInfo("leaf-a");
      expect(info).toEqual({ tabs: ["tab-1", "tab-2"], activeTab: 0 });
    });

    it("returns a copy of tabs (not a reference)", () => {
      dock.setLayout(twoLeafLayout());
      const info = dock.getLeafTabInfo("leaf-a");
      info.tabs.push("hacked");
      expect(dock.getLeafTabInfo("leaf-a").tabs).toEqual(["tab-1", "tab-2"]);
    });
  });

  // --- Tab cycling ---

  describe("cycleTabInLeaf", () => {
    it("cycles forward", () => {
      dock.setLayout(twoLeafLayout());
      dock.cycleTabInLeaf("leaf-a", 1);
      expect(dock.getLeafTabInfo("leaf-a").activeTab).toBe(1);
    });

    it("wraps around forward", () => {
      dock.setLayout(twoLeafLayout());
      dock.activateTab("tab-2"); // activeTab = 1
      dock.cycleTabInLeaf("leaf-a", 1);
      expect(dock.getActiveTabInLeaf("leaf-a")).toBe("tab-1");
    });

    it("wraps around backward", () => {
      dock.setLayout(twoLeafLayout());
      dock.cycleTabInLeaf("leaf-a", -1);
      expect(dock.getActiveTabInLeaf("leaf-a")).toBe("tab-2");
    });

    it("does nothing with single tab", () => {
      dock.setLayout(twoLeafLayout());
      dock.cycleTabInLeaf("leaf-b", 1);
      expect(dock.getActiveTabInLeaf("leaf-b")).toBe("tab-3");
    });
  });

  // --- Focus tracking ---

  describe("setFocusedLeaf", () => {
    it("tracks the last focused leaf", () => {
      dock.setLayout(twoLeafLayout());
      expect(dock.lastFocusedLeafId).toBeNull();

      dock.setFocusedLeaf("leaf-a");
      expect(dock.lastFocusedLeafId).toBe("leaf-a");

      dock.setFocusedLeaf("leaf-b");
      expect(dock.lastFocusedLeafId).toBe("leaf-b");
    });
  });

  describe("stale focus cleanup", () => {
    it("clears lastFocusedLeafId when focused leaf is removed", () => {
      dock.setLayout(twoLeafLayout());
      dock.setFocusedLeaf("leaf-b");
      expect(dock.lastFocusedLeafId).toBe("leaf-b");

      // Remove the only tab in leaf-b — leaf-b should be cleaned up
      dock.removeTab("tab-3");
      expect(dock.lastFocusedLeafId).toBeNull();
    });

    it("preserves lastFocusedLeafId when a different leaf is removed", () => {
      dock.setLayout({
        type: "split",
        direction: "horizontal",
        children: [
          { type: "leaf", id: "leaf-a", tabs: ["t1"], activeTab: 0 },
          { type: "leaf", id: "leaf-b", tabs: ["t2"], activeTab: 0 },
          { type: "leaf", id: "leaf-c", tabs: ["t3"], activeTab: 0 },
        ],
        sizes: [33, 33, 34],
      });
      dock.setFocusedLeaf("leaf-a");

      dock.removeTab("t2"); // removes leaf-b
      expect(dock.lastFocusedLeafId).toBe("leaf-a");
    });
  });

  // --- Tree cleanup ---

  describe("_cleanup", () => {
    it("collapses single-child split", () => {
      dock.setLayout({
        type: "split",
        direction: "horizontal",
        children: [
          { type: "leaf", id: "leaf-a", tabs: ["t1", "t2"], activeTab: 0 },
          { type: "leaf", id: "leaf-b", tabs: [], activeTab: 0 },
        ],
        sizes: [50, 50],
      });
      dock._cleanup();
      // Empty leaf-b removed, split collapsed to just leaf-a
      expect(dock.root.type).toBe("leaf");
      expect(dock.root.id).toBe("leaf-a");
    });
  });

  // --- Layout ---

  describe("getLayout / setLayout", () => {
    it("returns a deep copy", () => {
      const layout = twoLeafLayout();
      dock.setLayout(layout);
      const copy = dock.getLayout();
      copy.children[0].tabs.push("injected");
      expect(dock.getLeafTabInfo("leaf-a").tabs).toEqual(["tab-1", "tab-2"]);
    });

    it("returns null when no layout set", () => {
      expect(dock.getLayout()).toBeNull();
    });
  });

  describe("createDefaultLayout", () => {
    it("creates a two-leaf horizontal split", () => {
      const layout = createDefaultLayout(["a", "b"], ["c"]);
      expect(layout.type).toBe("split");
      expect(layout.direction).toBe("horizontal");
      expect(layout.children).toHaveLength(2);
      expect(layout.children[0].tabs).toEqual(["a", "b"]);
      expect(layout.children[1].tabs).toEqual(["c"]);
    });
  });

  // --- Split operations ---

  describe("moveTabToSplit", () => {
    it("moves tab to a new split", () => {
      dock.setLayout({
        type: "leaf",
        id: "leaf-a",
        tabs: ["t1", "t2"],
        activeTab: 0,
      });

      dock.moveTabToSplit("t2", "right");

      const leafIds = dock.getLeafIds();
      expect(leafIds).toHaveLength(2);
      // t1 stays in original leaf, t2 in new leaf
      expect(dock.getTabLeafId("t1")).not.toBe(dock.getTabLeafId("t2"));
    });

    it("sets lastFocusedLeafId to the new leaf", () => {
      dock.setLayout({
        type: "leaf",
        id: "leaf-a",
        tabs: ["t1", "t2"],
        activeTab: 0,
      });

      dock.moveTabToSplit("t2", "right");
      const t2Leaf = dock.getTabLeafId("t2");
      expect(dock.lastFocusedLeafId).toBe(t2Leaf);
    });
  });
});
