import { describe, expect, it } from "vitest";
import { clampFloatingPosition } from "./floating";

describe("clampFloatingPosition", () => {
  it("leaves a surface alone when it fits", () => {
    expect(clampFloatingPosition({ x: 100, y: 80, width: 224, height: 200, viewportWidth: 800, viewportHeight: 600 })).toEqual({ x: 100, y: 80 });
  });

  it("keeps a surface inside every viewport edge", () => {
    expect(clampFloatingPosition({ x: 790, y: 590, width: 224, height: 200, viewportWidth: 800, viewportHeight: 600 })).toEqual({ x: 564, y: 388 });
    expect(clampFloatingPosition({ x: -40, y: -20, width: 224, height: 200, viewportWidth: 800, viewportHeight: 600 })).toEqual({ x: 12, y: 12 });
  });
});
