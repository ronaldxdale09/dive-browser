import { describe, expect, it } from "vitest";
import { crosshairMove, fitZoom } from "./CaptureStudio";

describe("crosshairMove", () => {
  const size = { width: 1000, height: 500 };
  it("steps the same distance on screen at any zoom, ten times with Shift", () => {
    expect(crosshairMove({ x: 100, y: 100 }, "ArrowRight", false, 1, size)).toEqual({ x: 110, y: 100 });
    expect(crosshairMove({ x: 100, y: 100 }, "ArrowDown", true, 1, size)).toEqual({ x: 100, y: 200 });
    expect(crosshairMove({ x: 100, y: 100 }, "ArrowLeft", false, 0.5, size)).toEqual({ x: 80, y: 100 });
  });
  it("stays on the image and ignores other keys", () => {
    expect(crosshairMove({ x: 5, y: 495 }, "ArrowLeft", true, 1, size)).toEqual({ x: 0, y: 495 });
    expect(crosshairMove({ x: 5, y: 495 }, "ArrowDown", true, 1, size)).toEqual({ x: 5, y: 500 });
    expect(crosshairMove({ x: 5, y: 5 }, "Enter", false, 1, size)).toBeNull();
  });
});

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
