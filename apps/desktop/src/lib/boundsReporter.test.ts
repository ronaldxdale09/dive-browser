import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundsReporter, type Bounds } from "./boundsReporter";

describe("createBoundsReporter", () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("coalesces a burst into one frame and skips an unchanged rectangle", () => {
    let bounds: Bounds = { x: 1, y: 2, width: 300, height: 200 };
    const report = vi.fn();
    const reporter = createBoundsReporter(() => bounds, report);

    reporter.schedule();
    reporter.schedule();
    reporter.schedule();
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(report).toHaveBeenCalledTimes(1);

    reporter.schedule();
    frames.shift()?.(16);
    expect(report).toHaveBeenCalledTimes(1);

    bounds = { ...bounds, width: 320 };
    reporter.schedule();
    frames.shift()?.(32);
    expect(report).toHaveBeenLastCalledWith(bounds);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("cancels pending work when disposed", () => {
    const reporter = createBoundsReporter(() => ({ x: 0, y: 0, width: 1, height: 1 }), vi.fn());
    reporter.schedule();
    reporter.dispose();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });
});
