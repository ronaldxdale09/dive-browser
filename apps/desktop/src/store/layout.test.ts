import { uiStorage } from "../lib/uiStorage";
import { beforeEach, describe, expect, it } from "vitest";
import type { Tab } from "../lib/ipc";
import { DEFAULT_DOCK_HEIGHT, DEFAULT_SIDECAR_WIDTH, insertPane, useLayout, visibleSplit } from "./layout";

const tab = (id: string): Tab => ({ id, workspace_id: "ws", tier: "today", url: "https://a.test", title: id, favicon: null, position: 0, state: "active", last_active_at: "2026-09-04T00:00:00Z" });

describe("insertPane", () => {
  it("creates a split beside the anchor, on the side that was dropped", () => {
    expect(insertPane(undefined, "b", 0, "a")?.tabs).toEqual(["b", "a"]);
    expect(insertPane(undefined, "b", 1, "a")?.tabs).toEqual(["a", "b"]);
    expect(insertPane(undefined, "b", 1, "a")?.sizes).toEqual([0.5, 0.5]);
  });

  it("does nothing when a tab is dropped beside itself", () => {
    expect(insertPane(undefined, "a", 1, "a")).toBeUndefined();
  });

  it("moves a pane that is already in the split", () => {
    const split = { tabs: ["a", "b", "c"], sizes: [1 / 3, 1 / 3, 1 / 3] };
    expect(insertPane(split, "a", 3, null)?.tabs).toEqual(["b", "c", "a"]);
    expect(insertPane(split, "c", 0, null)?.tabs).toEqual(["c", "a", "b"]);
    expect(insertPane(split, "b", 1, null)?.tabs).toEqual(["a", "b", "c"]);
  });

  it("refuses a fifth pane", () => {
    const split = { tabs: ["a", "b", "c", "d"], sizes: [0.25, 0.25, 0.25, 0.25] };
    expect(insertPane(split, "e", 2, null)).toBe(split);
  });
});

describe("visibleSplit", () => {
  const split = { tabs: ["a", "b"], sizes: [0.5, 0.5] };
  it("shows when the active tab is a pane and every pane is open here", () => {
    expect(visibleSplit(split, "a", [tab("a"), tab("b")], [])).toBe(split);
  });
  it("steps aside for a tab outside the split, a closed pane, or a detached one", () => {
    expect(visibleSplit(split, "c", [tab("a"), tab("b"), tab("c")], [])).toBeNull();
    expect(visibleSplit(split, "a", [tab("a")], [])).toBeNull();
    expect(visibleSplit(split, "a", [tab("a"), tab("b")], ["b"])).toBeNull();
  });
});

describe("panel layout persistence", () => {
  beforeEach(() => {
    uiStorage.clear();
    useLayout.setState({ dockHeight: DEFAULT_DOCK_HEIGHT, sidecarWidth: DEFAULT_SIDECAR_WIDTH, dockPanel: "console", openPanels: { sidecar: false, dock: false } });
  });

  const stored = () => JSON.parse(uiStorage.getItem("dive.layout") ?? "{}").state;

  it("keeps the dock and sidecar sizes within their limits", () => {
    useLayout.getState().setDockHeight(300);
    useLayout.getState().setSidecarWidth(5000);
    expect(useLayout.getState().dockHeight).toBe(300);
    expect(useLayout.getState().sidecarWidth).toBe(720);
    useLayout.getState().setDockHeight(1);
    expect(useLayout.getState().dockHeight).toBe(160);
  });

  it("writes sizes, the chosen dock panel and the open panels to storage", () => {
    useLayout.getState().setDockHeight(320);
    useLayout.getState().setSidecarWidth(400);
    useLayout.getState().setDockPanel("network");
    useLayout.getState().setOpenPanels({ sidecar: true, dock: false });
    expect(stored()).toMatchObject({ dockHeight: 320, sidecarWidth: 400, dockPanel: "network", openPanels: { sidecar: true, dock: false } });
  });

  it("ignores an open-panels update that changes nothing", () => {
    const before = useLayout.getState().openPanels;
    useLayout.getState().setOpenPanels({ sidecar: false, dock: false });
    expect(useLayout.getState().openPanels).toBe(before);
  });

  it("clamps sizes read back from storage", () => {
    uiStorage.setItem("dive.layout", JSON.stringify({ state: { splits: {}, dockHeight: 5, sidecarWidth: 9999, dockPanel: "meta" }, version: 1 }));
    useLayout.persist.rehydrate();
    expect(useLayout.getState().dockHeight).toBe(160);
    expect(useLayout.getState().sidecarWidth).toBe(720);
    expect(useLayout.getState().dockPanel).toBe("meta");
    expect(useLayout.getState().openPanels).toEqual({ sidecar: false, dock: false });
  });
});
