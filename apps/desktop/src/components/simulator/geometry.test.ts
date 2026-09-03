import { describe, expect, it } from "vitest";
import { customDevice, deviceById } from "../../data/devices";
import { layoutFor, safeAreaFor, scaleFor, stripsAround, viewportFor } from "./geometry";

const iphone15 = deviceById("iphone-15")!;
const pixel8 = deviceById("pixel-8")!;
const se = deviceById("iphone-se")!;
const laptop = deviceById("laptop")!;

describe("viewport", () => {
  it("gives Safari on an iPhone 15 the viewport Safari actually gives", () => {
    // 852 − 59 status − 134 bottom bar. The number a `100vh` page is laid
    // out against on the real phone.
    expect(viewportFor(iphone15, false, "browser")).toEqual({ width: 393, height: 659 });
  });

  it("gives a standalone web app the screen minus status bar and home indicator", () => {
    expect(viewportFor(iphone15, false, "standalone")).toEqual({ width: 393, height: 759 });
  });

  it("hands over the whole screen when nothing is drawn", () => {
    expect(viewportFor(iphone15, false, "none")).toEqual({ width: 393, height: 852 });
  });

  it("rotates and loses the status bar to the compact landscape Safari", () => {
    expect(viewportFor(iphone15, true, "browser")).toEqual({ width: 852, height: 322 });
  });

  it("models the classic iPhone's top address bar", () => {
    // 667 − 20 status − 44 address bar − 44 toolbar: the well-known 559.
    expect(viewportFor(se, false, "browser")).toEqual({ width: 375, height: 559 });
  });

  it("models Chrome on Android", () => {
    expect(viewportFor(pixel8, false, "browser")).toEqual({ width: 412, height: 915 - 24 - 56 - 24 });
  });

  it("never draws strips around a laptop, whatever the mode", () => {
    for (const mode of ["browser", "standalone", "none"] as const) {
      expect(stripsAround(laptop, false, mode)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
      expect(viewportFor(laptop, false, mode)).toEqual({ width: 1366, height: 768 });
    }
  });
});

describe("safe area", () => {
  it("is zero in browser mode, as Safari reports it", () => {
    expect(safeAreaFor(iphone15, false, "browser")).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("is the device's insets in standalone portrait", () => {
    expect(safeAreaFor(iphone15, false, "standalone")).toEqual({ top: 59, bottom: 34, left: 0, right: 0 });
  });

  it("moves to the sides in standalone landscape", () => {
    expect(safeAreaFor(iphone15, true, "standalone")).toEqual({ top: 0, bottom: 21, left: 59, right: 59 });
  });
});

describe("scale", () => {
  const screen = { width: 393, height: 852 };
  const bezel = { sides: 12, top: 12, bottom: 12 };

  it("is 1 when the frame fits", () => {
    expect(scaleFor(screen, bezel, { width: 2000, height: 2000 }, "fit")).toBe(1);
  });

  it("shrinks to fit the shorter dimension, keeping the padding", () => {
    // 600 tall stage, 24 padding each side, 876 outer height → 552/876.
    const s = scaleFor(screen, bezel, { width: 2000, height: 600 }, "fit");
    expect(s).toBeCloseTo(552 / 876, 5);
  });

  it("uses a fixed zoom when asked, even when it does not fit", () => {
    expect(scaleFor(screen, bezel, { width: 300, height: 300 }, 100)).toBe(1);
    expect(scaleFor(screen, bezel, { width: 300, height: 300 }, 50)).toBe(0.5);
  });

  it("never collapses to nothing on a tiny stage", () => {
    expect(scaleFor(screen, bezel, { width: 10, height: 10 }, "fit")).toBeGreaterThan(0);
    expect(scaleFor(screen, bezel, { width: 0, height: 0 }, "fit")).toBeGreaterThan(0);
  });
});

describe("layout", () => {
  it("reports an outer size in chrome pixels and a viewport in device pixels", () => {
    const layout = layoutFor(iphone15, false, "browser", 50, { width: 2000, height: 2000 });
    expect(layout.scale).toBe(0.5);
    expect(layout.outer).toEqual({ width: Math.round((393 + 24) * 0.5), height: Math.round((852 + 24) * 0.5) });
    // The viewport is unscaled: that is what the engine is told.
    expect(layout.viewport).toEqual({ width: 393, height: 659 });
  });

  it("treats a custom size like a bare viewport", () => {
    const custom = customDevice(1024, 768);
    const layout = layoutFor(custom, false, "none", "fit", { width: 3000, height: 3000 });
    expect(layout.viewport).toEqual({ width: 1024, height: 768 });
    expect(layout.strips).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
});
