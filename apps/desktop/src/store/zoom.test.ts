import { describe, expect, it } from "vitest";
import { ZOOM_STEPS, nextZoom } from "./browser";

describe("nextZoom", () => {
  it("steps through the table", () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
  });
  it("clamps at both ends", () => {
    expect(nextZoom(3, 1)).toBe(3);
    expect(nextZoom(0.5, -1)).toBe(0.5);
  });
  it("snaps an off-table value to the nearest step in the direction", () => {
    expect(nextZoom(1.3, 1)).toBe(1.5);
    expect(nextZoom(1.3, -1)).toBe(1.25);
    expect(ZOOM_STEPS).toContain(1);
  });
});
