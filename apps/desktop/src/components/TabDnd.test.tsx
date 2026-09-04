import { describe, expect, it } from "vitest";
import { planDrop, paneId, zoneId } from "./TabDnd";

const viewport = { width: 1200, height: 800 };
const stripBottom = 44;
const ordered = ["a", "b", "c"];

describe("planDrop", () => {
  it("reorders when dropped on another tab in the strip", () => {
    const plan = planDrop({ dragged: "a", fromPane: false, over: "c", ordered, pointer: { x: 300, y: 20 }, viewport, stripBottom });
    expect(plan).toEqual({ kind: "reorder", ordered: ["b", "c", "a"] });
  });

  it("splits when dropped on a side of the page, from the strip or from a pane", () => {
    expect(planDrop({ dragged: "b", fromPane: false, over: zoneId(1, "a:r"), ordered, pointer: { x: 900, y: 400 }, viewport, stripBottom })).toEqual({ kind: "split", tab: "b", index: 1 });
    expect(planDrop({ dragged: paneId("b"), fromPane: true, over: zoneId(0, "a:l"), ordered, pointer: { x: 100, y: 400 }, viewport, stripBottom })).toEqual({ kind: "split", tab: "b", index: 0 });
  });

  it("opens a window when let go past the window's edge", () => {
    const plan = planDrop({ dragged: "a", fromPane: false, over: null, ordered, pointer: { x: 1300, y: 120 }, viewport, stripBottom });
    expect(plan).toEqual({ kind: "detach", tab: "a", at: { x: 1300, y: 120 } });
  });

  it("opens a window when a strip tab is released after clearly leaving the strip", () => {
    expect(planDrop({ dragged: "a", fromPane: false, over: null, ordered, pointer: { x: 600, y: 300 }, viewport, stripBottom })).toEqual({ kind: "detach", tab: "a", at: { x: 600, y: 300 } });
  });

  it("does nothing for a wobble inside the strip, or a pane let go off any zone", () => {
    expect(planDrop({ dragged: "a", fromPane: false, over: null, ordered, pointer: { x: 600, y: 30 }, viewport, stripBottom })).toEqual({ kind: "none" });
    expect(planDrop({ dragged: "a", fromPane: false, over: "a", ordered, pointer: { x: 60, y: 20 }, viewport, stripBottom })).toEqual({ kind: "none" });
    expect(planDrop({ dragged: paneId("b"), fromPane: true, over: null, ordered, pointer: { x: 600, y: 300 }, viewport, stripBottom })).toEqual({ kind: "none" });
  });
});
