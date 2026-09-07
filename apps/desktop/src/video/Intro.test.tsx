import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { INTRO_DURATION, INTRO_FPS, INTRO_HEIGHT, INTRO_POSTER_FRAME, INTRO_WIDTH, Intro } from "./Intro";

const clock = vi.hoisted(() => ({ frame: 0 }));
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return {
    ...actual,
    useCurrentFrame: () => clock.frame,
    useVideoConfig: () => ({ fps: INTRO_FPS, durationInFrames: INTRO_DURATION, width: INTRO_WIDTH, height: INTRO_HEIGHT, id: "intro", defaultProps: {}, props: {}, defaultCodec: null, defaultOutName: null, defaultVideoImageFormat: null, defaultPixelFormat: null }),
  };
});

describe("Intro", () => {
  it("runs five seconds and keeps the poster inside the reel, before the clear", () => {
    expect(INTRO_DURATION).toBe(5 * INTRO_FPS);
    expect(INTRO_POSTER_FRAME).toBeGreaterThan(0);
    expect(INTRO_POSTER_FRAME).toBeLessThan(INTRO_DURATION - 22);
  });

  it("assembles the mark from scattered dots and clears the copy at the end", () => {
    const dotsAt = (frame: number) => {
      clock.frame = frame;
      const { container, unmount } = render(<Intro />);
      const circles = Array.from(container.querySelectorAll("circle"));
      const wordmark = container.textContent ?? "";
      const out = { circles: circles.length, faint: circles.filter((c) => Number(c.getAttribute("opacity")) < 0.05).length, wordmark };
      unmount();
      return out;
    };
    // Frame zero: every dot exists but none has arrived, so none has any weight yet.
    const start = dotsAt(0);
    expect(start.circles).toBe(180);
    expect(start.faint).toBe(180);
    // By the poster frame the dots have landed and the copy is on screen.
    const poster = dotsAt(INTRO_POSTER_FRAME);
    expect(poster.faint).toBe(0);
    expect(poster.wordmark).toContain("DIVE");
    expect(poster.wordmark).toContain("The browser built for developers");
    expect(poster.wordmark).toContain("Workspaces");
  });
});
