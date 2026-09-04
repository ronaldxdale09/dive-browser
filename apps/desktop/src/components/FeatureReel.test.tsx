import { act, cleanup, render } from "@testing-library/react";
import { useImperativeHandle } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { FeatureReel } from "./FeatureReel";

const player = vi.hoisted(() => ({ isPlaying: vi.fn(() => true), pause: vi.fn(), play: vi.fn(), seekTo: vi.fn() }));
vi.mock("@remotion/player", () => ({ Player: (props: { ref: React.Ref<typeof player> }) => { useImperativeHandle(props.ref, () => player); return null; } }));
vi.mock("../video/Showcase", () => ({ DURATION: 60, POSTER_FRAME: 10, Showcase: () => null }));
vi.mock("../video/primitives", () => ({ FPS: 30, WIDTH: 100, HEIGHT: 60 }));
afterEach(() => { cleanup(); usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true }); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("resumes only previously playing tours and never overrides a manual pause", () => {
  let intersection!: (entries: { isIntersecting: boolean }[]) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof intersection) { intersection = callback; }
    observe() {}
    disconnect() {}
  });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  player.isPlaying.mockReturnValue(true);
  render(<FeatureReel />);
  expect(player.play).not.toHaveBeenCalled();
  act(() => intersection([{ isIntersecting: false }]));
  expect(player.pause).toHaveBeenCalledTimes(1);
  // Multiple invisible notifications must not forget that playback was suspended.
  player.isPlaying.mockReturnValue(false);
  act(() => intersection([{ isIntersecting: false }]));
  act(() => intersection([{ isIntersecting: true }]));
  expect(player.play).toHaveBeenCalledTimes(1);
  // A person pauses the tour before scrolling away again.
  act(() => intersection([{ isIntersecting: false }]));
  act(() => intersection([{ isIntersecting: true }]));
  expect(player.play).toHaveBeenCalledTimes(1);
});

it("still pauses explicitly played tours on hide when Reduce is selected", () => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  usePrefs.setState({ prefs: { ...DEFAULT_PREFS, motion: "reduce" }, loaded: true });
  render(<FeatureReel />);
  expect(player.pause).toHaveBeenCalledTimes(1);
  player.isPlaying.mockReturnValue(true);
  act(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(player.pause).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
