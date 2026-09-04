import { describe, expect, it } from "vitest";
import { Spring, buildSegments, cameraAt, cameraTransform, clampFocus, clickBounce, contentBox, cursorAt, outputDuration, outputSize, outputTime, smoothCursorPath, sourceTime, suggestZooms, zoomScale, zoomStrength } from "./math";
import type { CursorSample, ZoomRegion } from "./model";

const zoom = (startMs: number, endMs: number, extra: Partial<ZoomRegion> = {}): ZoomRegion => ({ id: `z${startMs}`, startMs, endMs, depth: 3, focus: { cx: 0.5, cy: 0.5 }, focusMode: "manual", source: "manual", ...extra });

describe("segments", () => {
  it("cuts trims out and stretches or squeezes speed regions", () => {
    const segs = buildSegments(10_000, [{ id: "t", startMs: 2_000, endMs: 4_000 }], [{ id: "s", startMs: 6_000, endMs: 10_000, speed: 2 }]);
    expect(segs.map((s) => [s.srcStartMs, s.srcEndMs, s.speed])).toEqual([
      [0, 2_000, 1],
      [4_000, 6_000, 1],
      [6_000, 10_000, 2],
    ]);
    expect(outputDuration(segs)).toBe(6_000);
    expect(sourceTime(segs, 1_000)).toBe(1_000);
    expect(sourceTime(segs, 2_500)).toBe(4_500);
    expect(sourceTime(segs, 5_000)).toBe(8_000);
    expect(outputTime(segs, 3_000)).toBe(2_000);
    expect(outputTime(segs, 8_000)).toBe(5_000);
  });

  it("keeps a whole untouched video as one segment", () => {
    const segs = buildSegments(5_000, [], []);
    expect(segs).toHaveLength(1);
    expect(outputDuration(segs)).toBe(5_000);
    expect(sourceTime(segs, 5_000)).toBe(5_000);
  });
});

describe("zoom timing", () => {
  it("eases in ahead of the region, holds, and eases out after it", () => {
    const z = zoom(5_000, 8_000);
    expect(zoomStrength(z, 3_000)).toBe(0);
    expect(zoomStrength(z, 4_500)).toBeGreaterThan(0);
    expect(zoomStrength(z, 5_500)).toBe(1);
    expect(zoomStrength(z, 8_000)).toBe(1);
    expect(zoomStrength(z, 8_500)).toBeGreaterThan(0);
    expect(zoomStrength(z, 8_500)).toBeLessThan(1);
    expect(zoomStrength(z, 9_100)).toBe(0);
  });

  it("uses the depth table unless a custom scale is set", () => {
    expect(zoomScale(zoom(0, 1))).toBe(1.8);
    expect(zoomScale(zoom(0, 1, { depth: 6 }))).toBe(5);
    expect(zoomScale(zoom(0, 1, { customScale: 2.3 }))).toBe(2.3);
  });

  it("glides between two zooms that nearly touch instead of zooming out", () => {
    const a = zoom(1_000, 3_000, { focus: { cx: 0.2, cy: 0.2 } });
    const b = zoom(4_000, 6_000, { depth: 5, focus: { cx: 0.8, cy: 0.8 } });
    const focus = (z: ZoomRegion) => z.focus;
    const mid = cameraAt([a, b], 3_500, focus);
    expect(mid.scale).toBeGreaterThan(1.8);
    expect(mid.scale).toBeLessThan(3.5);
    expect(mid.cx).toBeGreaterThan(0.2);
    expect(mid.cx).toBeLessThan(0.8);
    // Before the first zoom's lead-in there is no camera movement at all.
    expect(cameraAt([zoom(5_000, 6_000)], 0, focus)).toEqual({ scale: 1, cx: 0.5, cy: 0.5 });
  });

  it("keeps the zoomed viewport inside the frame", () => {
    expect(clampFocus(0, 0, 2)).toEqual({ cx: 0.25, cy: 0.25 });
    expect(clampFocus(1, 1, 2)).toEqual({ cx: 0.75, cy: 0.75 });
    const t = cameraTransform({ scale: 2, cx: 0.5, cy: 0.5 }, 1000, 500);
    expect(t).toEqual({ scale: 2, x: -500, y: -250 });
  });
});

describe("spring", () => {
  it("settles on its target without overshooting", () => {
    const s = new Spring(0);
    let max = 0;
    for (let i = 0; i < 200; i++) max = Math.max(max, s.step(1, 16));
    expect(max).toBeLessThanOrEqual(1);
    expect(s.value).toBeCloseTo(1, 3);
  });
});

describe("cursor", () => {
  const samples: CursorSample[] = [
    { timeMs: 0, cx: 0, cy: 0 },
    { timeMs: 100, cx: 1, cy: 1 },
    { timeMs: 1_000, cx: 0, cy: 0 },
  ];
  it("interpolates close samples and jumps across long gaps", () => {
    expect(cursorAt(samples, 50)).toEqual({ cx: 0.5, cy: 0.5 });
    expect(cursorAt(samples, 200)).toEqual({ cx: 1, cy: 1 });
    expect(cursorAt(samples, 900)).toEqual({ cx: 0, cy: 0 });
    expect(cursorAt([], 0)).toBeNull();
  });

  it("smooths the path onto a fixed grid, lagging the raw pointer", () => {
    const smooth = smoothCursorPath(samples, 0.67);
    expect(smooth.length).toBeGreaterThan(samples.length);
    const at100 = smooth.find((s) => s.timeMs >= 100)!;
    expect(at100.cx).toBeLessThan(1);
    expect(smoothCursorPath(samples, 0)).toBe(samples);
  });

  it("bounces on a click and rests otherwise", () => {
    expect(clickBounce(70, 2.5)).toBeLessThan(1);
    expect(clickBounce(200, 2.5)).toBe(1);
    expect(clickBounce(70, 0)).toBe(1);
  });
});

describe("suggestZooms", () => {
  it("finds a dwell and places one zoom on it, skipping taken ground", () => {
    const samples: CursorSample[] = [];
    // A second of sweeping, then a second of dwelling, then more sweeping.
    for (let t = 0; t < 1_000; t += 50) samples.push({ timeMs: t, cx: t / 1_000, cy: 0.5 });
    for (let t = 1_000; t <= 2_000; t += 50) samples.push({ timeMs: t, cx: 0.8, cy: 0.6 });
    for (let t = 2_050; t < 3_000; t += 50) samples.push({ timeMs: t, cx: 1 - (t - 2_000) / 1_000, cy: 0.5 });
    const made = suggestZooms(samples, 20_000, [], (startMs, endMs, cx, cy) => zoom(startMs, endMs, { focus: { cx, cy }, source: "auto" }));
    expect(made).toHaveLength(1);
    expect(made[0]!.focus.cx).toBeCloseTo(0.8, 2);
    expect(made[0]!.endMs - made[0]!.startMs).toBe(1_000);
    expect(suggestZooms(samples, 20_000, made, () => zoom(0, 1))).toHaveLength(0);
  });
});

describe("canvas", () => {
  it("sizes the output evenly for a ratio and resolution", () => {
    expect(outputSize("16:9", "1080p", { width: 1280, height: 800 })).toEqual({ width: 1920, height: 1080 });
    expect(outputSize("9:16", "720p", { width: 1280, height: 800 })).toEqual({ width: 720, height: 1280 });
    expect(outputSize("native", "source", { width: 1281, height: 801 })).toEqual({ width: 1282, height: 802 });
  });

  it("fits the video inside the padded box", () => {
    const box = contentBox(1920, 1080, 50, 1280, 800);
    expect(box.w).toBeLessThanOrEqual(1920 * 0.8);
    expect(box.h).toBeCloseTo(box.w / 1.6, 5);
    expect(box.x).toBeCloseTo((1920 - box.w) / 2, 5);
  });
});
