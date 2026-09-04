import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSegments, outputDuration } from "./math";
import { newProject } from "./model";
import { Stage } from "./Stage";
import { useEditor } from "./store";

const media = {
  source: "/tmp/recording.mp4",
  playable: "/tmp/recording.webm",
  events: null,
  durationMs: 10_000,
  width: 1280,
  height: 720,
};

describe("Stage playback rendering", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const project = newProject(media);
    const segments = buildSegments(media.durationMs, [], []);
    useEditor.setState({
      project,
      source: media.source,
      playable: null,
      segments,
      duration: outputDuration(segments),
      playhead: 0,
      playing: true,
      selection: null,
      cursorRaw: [],
      cursorSmooth: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useEditor.setState({ project: null, source: null, playable: null, playhead: 0, playing: false });
  });

  it("does not commit the preview chrome for animation-frame playhead updates", () => {
    let commits = 0;
    render(
      <Profiler id="stage" onRender={() => commits++}>
        <Stage />
      </Profiler>,
    );
    const afterMount = commits;

    for (const playhead of [100, 200, 300, 400, 500]) {
      act(() => useEditor.setState({ playhead }));
    }

    expect(commits - afterMount).toBe(0);
  });
});
