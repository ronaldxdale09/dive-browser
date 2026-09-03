import { describe, expect, it } from "vitest";
import { DURATION, POSTER_FRAME, SCENES } from "./Showcase";
import { FPS } from "./primitives";

describe("Showcase", () => {
  it("runs exactly one minute and loops without a gap", () => {
    expect(DURATION).toBe(60 * FPS);
    expect(SCENES.reduce((n, s) => n + s.duration, 0)).toBe(DURATION);
  });

  it("gives every built-in feature its own scene between the bookends", () => {
    expect(SCENES[0]?.name).toBe("intro");
    expect(SCENES.at(-1)?.name).toBe("outro");
    const features = SCENES.slice(1, -1);
    expect(features).toHaveLength(12);
    expect(new Set(features.map((s) => s.name)).size).toBe(12);
    // Equal time each: no feature is the poor relation.
    expect(new Set(features.map((s) => s.duration)).size).toBe(1);
  });

  it("has a poster frame inside the reel for reduced motion", () => {
    expect(POSTER_FRAME).toBeGreaterThan(0);
    expect(POSTER_FRAME).toBeLessThan(DURATION);
  });
});
