import { describe, expect, it } from "vitest";
import { fitZoom } from "./CaptureStudio";

describe("fitZoom", () => {
  it("scales a wide capture down to the viewing area, less its padding", () => {
    expect(fitZoom("fit", 948, 2456)).toBeCloseTo((948 - 64) / 2456, 5);
  });
  it("never enlarges a narrow capture past its actual size", () => {
    expect(fitZoom("fit", 2000, 800)).toBe(1);
  });
  it("keeps a chosen zoom and copes with an unmeasured area", () => {
    expect(fitZoom(0.5, 948, 2456)).toBe(0.5);
    expect(fitZoom("fit", 0, 2456)).toBe(1);
  });
});
