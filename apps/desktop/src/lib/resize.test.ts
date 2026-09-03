import { describe, expect, it } from "vitest";
import { DOCK_LIMITS, SIDECAR_LIMITS, clampSize, dragSize, nudgeSize } from "./resize";

describe("clampSize", () => {
  it("keeps a size inside its limits and rounds to whole pixels", () => {
    expect(clampSize(300.4, DOCK_LIMITS)).toBe(300);
    expect(clampSize(10, DOCK_LIMITS)).toBe(160);
    expect(clampSize(9000, DOCK_LIMITS)).toBe(600);
    expect(clampSize(Number.NaN, SIDECAR_LIMITS)).toBe(280);
  });
});

describe("dragSize", () => {
  it("grows a bottom dock as its top edge is dragged up, and a right sidecar as its left edge goes left", () => {
    expect(dragSize(240, -40, -1, DOCK_LIMITS)).toBe(280);
    expect(dragSize(240, 40, -1, DOCK_LIMITS)).toBe(200);
    expect(dragSize(360, -100, -1, SIDECAR_LIMITS)).toBe(460);
  });

  it("stops at the limits however far the pointer goes", () => {
    expect(dragSize(240, -2000, -1, DOCK_LIMITS)).toBe(600);
    expect(dragSize(240, 2000, -1, DOCK_LIMITS)).toBe(160);
    expect(dragSize(360, 5000, -1, SIDECAR_LIMITS)).toBe(280);
  });
});

describe("nudgeSize", () => {
  it("moves one step per key press and respects the limits", () => {
    expect(nudgeSize(240, 1, DOCK_LIMITS)).toBe(256);
    expect(nudgeSize(240, -1, DOCK_LIMITS)).toBe(224);
    expect(nudgeSize(598, 1, DOCK_LIMITS)).toBe(600);
    expect(nudgeSize(300, 1, SIDECAR_LIMITS, 50)).toBe(350);
  });
});
