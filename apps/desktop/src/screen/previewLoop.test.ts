import { describe, expect, it } from "vitest";
import { PlaybackClock, previewNeedsFrame } from "./previewLoop";

describe("previewNeedsFrame", () => {
  it("keeps drawing only while playback or media work is active", () => {
    expect(previewNeedsFrame(true, 4, false)).toBe(true);
    expect(previewNeedsFrame(false, 1, false)).toBe(true);
    expect(previewNeedsFrame(false, 4, true)).toBe(true);
    expect(previewNeedsFrame(false, 4, false)).toBe(false);
  });
});

describe("PlaybackClock", () => {
  it("clamps at the end and reports it", () => {
    const clock = new PlaybackClock(900);
    expect(clock.advance(50, 1000)).toEqual({ outMs: 950, ended: false });
    expect(clock.advance(500, 1000)).toEqual({ outMs: 1000, ended: true });
  });

  it("tells its own playhead writes from seeks", () => {
    const clock = new PlaybackClock(0);
    expect(clock.sought(4000)).toBe(false);
    clock.wrote(1000);
    expect(clock.sought(1000)).toBe(false);
    expect(clock.sought(4000)).toBe(true);
  });

  it("jumps to a position and forgets the last write", () => {
    const clock = new PlaybackClock(0);
    clock.wrote(1000);
    clock.jump(2500);
    expect(clock.outMs).toBe(2500);
    expect(clock.sought(4000)).toBe(false);
  });
});
