import { describe, expect, it } from "vitest";
import { INTRO_EXIT_MS, introLeaveDelayMs } from "./IntroScene";

describe("IntroScene", () => {
  it("does not fade the intro out under reduced motion", () => {
    // useFadeClose already hands over at once when motion is reduced.
    // The sting must not play a 420ms opacity fade after a still poster.
    expect(introLeaveDelayMs(true)).toBe(0);
    expect(introLeaveDelayMs(false)).toBe(INTRO_EXIT_MS);
  });
});
