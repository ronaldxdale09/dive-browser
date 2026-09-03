import { describe, expect, it } from "vitest";
import { BOOKEND, DURATION, FEATURE, FEATURES, POSTER_FRAME, SEQUENCES, TRANSITION } from "./Showcase";
import { FPS } from "./primitives";

describe("Showcase", () => {
  it("runs exactly one minute once the crossfade overlaps are taken off", () => {
    expect(DURATION).toBe(60 * FPS);
    // The rule from @remotion/transitions: total = sum of sequences − transitions.
    const sum = SEQUENCES.reduce((n, d) => n + d, 0);
    expect(sum - TRANSITION * (SEQUENCES.length - 1)).toBe(DURATION);
    expect(SEQUENCES).toEqual([BOOKEND, ...Array<number>(12).fill(FEATURE), BOOKEND]);
  });

  it("gives every built-in feature its own scene, leading with the visible ones", () => {
    expect(FEATURES).toHaveLength(12);
    expect(new Set(FEATURES.map((f) => f.name)).size).toBe(12);
    expect(FEATURES.slice(0, 4).map((f) => f.name)).toEqual(["recording", "capture", "mobile", "agent"]);
  });

  it("has a poster frame inside the reel for reduced motion", () => {
    expect(POSTER_FRAME).toBeGreaterThan(0);
    expect(POSTER_FRAME).toBeLessThan(DURATION);
  });
});
