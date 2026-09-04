import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSegments, outputDuration } from "./math";
import { newProject } from "./model";
import { useEditor } from "./store";
import { Timeline } from "./Timeline";

const media = {
  source: "/tmp/recording.mp4",
  playable: "/tmp/recording.webm",
  events: null,
  durationMs: 10_000,
  width: 1280,
  height: 720,
};

describe("Timeline playback rendering", () => {
  beforeEach(() => {
    const project = newProject(media);
    const segments = buildSegments(media.durationMs, [], []);
    useEditor.setState({
      project,
      source: media.source,
      playable: "blob:test",
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
    useEditor.setState({ project: null, source: null, playable: null, playhead: 0, playing: false });
  });

  it("does not commit the entire timeline for animation-frame playhead updates", () => {
    let commits = 0;
    render(
      <Profiler id="timeline" onRender={() => commits++}>
        <Timeline />
      </Profiler>,
    );
    const afterMount = commits;

    for (const playhead of [100, 200, 300, 400, 500]) {
      act(() => useEditor.setState({ playhead }));
    }

    expect(commits - afterMount).toBe(0);
  });
});
