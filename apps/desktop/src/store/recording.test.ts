import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, describeLimits, effectiveSettings, elapsedSeconds } from "./recording";

const caps = { ffmpeg: true, microphones: [{ id: "0", name: "Built-in" }], video_max_seconds: 600, gif_max_seconds: 60 };

describe("elapsedSeconds", () => {
  it("counts recorded time only, leaving pauses out", () => {
    const t0 = 1_000_000;
    expect(elapsedSeconds({ startedAt: t0, pausedAt: null, pausedTotal: 0 }, t0 + 12_000)).toBe(12);
    expect(elapsedSeconds({ startedAt: t0, pausedAt: null, pausedTotal: 4_000 }, t0 + 12_000)).toBe(8);
    // Paused right now: the clock stands still at the pause.
    expect(elapsedSeconds({ startedAt: t0, pausedAt: t0 + 5_000, pausedTotal: 0 }, t0 + 12_000)).toBe(5);
    expect(elapsedSeconds({ startedAt: null, pausedAt: null, pausedTotal: 0 })).toBe(0);
  });
});

describe("effectiveSettings", () => {
  it("falls back to GIF without ffmpeg and drops a microphone a GIF cannot carry", () => {
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, microphone: "0" }, { ...caps, ffmpeg: false })).toMatchObject({ format: "gif", microphone: null });
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, format: "gif", microphone: "0" }, caps).microphone).toBeNull();
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, microphone: "0" }, caps).microphone).toBe("0");
    // An unplugged microphone is not asked for.
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, microphone: "7" }, caps).microphone).toBeNull();
  });
});

describe("effectiveSettings (source)", () => {
  it("cannot record the window without ffmpeg", () => {
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, source: "window" }, { ...caps, ffmpeg: false }).source).toBe("page");
    expect(effectiveSettings({ ...DEFAULT_SETTINGS, source: "window" }, caps).source).toBe("window");
  });
});

describe("describeLimits", () => {
  it("states the cap for the chosen format", () => {
    expect(describeLimits(DEFAULT_SETTINGS, caps)).toContain("Up to 10 min");
    expect(describeLimits({ ...DEFAULT_SETTINGS, format: "gif" }, caps)).toContain("Up to 1 min");
    expect(describeLimits({ ...DEFAULT_SETTINGS, source: "window" }, caps)).toContain("pointer included");
  });
});
