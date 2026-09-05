import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Stage } from "./Stage";
import { newProject } from "./model";
import { useEditor } from "./store";

const media = { source: "recording.mp4", playable: "asset:recording.webm", events: null, durationMs: 5000, width: 640, height: 360 };
let loaded: (string | null)[];
let pause: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  loaded = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (this: HTMLMediaElement) { loaded.push(this.getAttribute("src")); });
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  useEditor.setState({ source: media.source, project: newProject(media), playable: media.playable, generation: 10, error: null, dirty: false, playing: false, videoEl: null });
});
afterEach(() => {
  cleanup();
  useEditor.setState({ source: null, project: null, playable: null, videoEl: null, error: null });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("unloads the retired preview resource instead of only detaching its DOM", () => {
  const view = render(<Stage />);
  const video = view.container.querySelector("video")!;
  expect(useEditor.getState().videoEl).toBe(video);
  view.unmount();
  expect(video.hasAttribute("src")).toBe(false);
  expect(loaded.at(-1)).toBeNull();
  expect(pause).toHaveBeenCalled();
  expect(useEditor.getState().videoEl).toBeNull();
});

it("does not pause a replacement resource when an old metadata nudge resolves", async () => {
  let resolve!: () => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
  const view = render(<Stage />);
  const video = view.container.querySelector("video")!;
  await act(() => vi.advanceTimersByTimeAsync(400));
  act(() => useEditor.setState({ playable: "asset:replacement.webm" }));
  expect(video.getAttribute("src")).toBe("asset:replacement.webm");
  pause.mockClear();
  await act(async () => { resolve(); await Promise.resolve(); });
  expect(pause).not.toHaveBeenCalled();
});

it("does not release another stage's borrowed element or report errors for a newer generation", () => {
  const view = render(<Stage />);
  const oldVideo = view.container.querySelector("video")!;
  const replacement = document.createElement("video");
  act(() => useEditor.setState({ generation: 11, videoEl: replacement }));
  fireEvent.error(oldVideo);
  expect(useEditor.getState().error).toBeNull();
  view.unmount();
  expect(useEditor.getState().videoEl).toBe(replacement);
});

it("logs bounded decoder facts and preserves the existing error UI for its current resource", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = render(<Stage />);
  const video = view.container.querySelector("video")!;
  Object.defineProperty(video, "error", { configurable: true, value: { code: 3, message: "decoder rejected frame" } });
  fireEvent.error(video);
  expect(useEditor.getState().error).toBe("Dive could not decode this recording preview. The original file is still safe.");
  expect(log).toHaveBeenCalledWith("[divescreen] preview media failed", { code: 3, readyState: 0, networkState: 0 });
});
