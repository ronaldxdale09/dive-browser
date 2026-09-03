import { describe, expect, it } from "vitest";
import type { Tab } from "../lib/ipc";
import { insertPane, visibleSplit } from "./layout";

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
