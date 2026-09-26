import { afterEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import type { RecordedStep } from "../lib/ipc";
import { useBrowser } from "./browser";
import { appendStep, finalSteps, STEP_CAP, useRecorder } from "./recorder";

const step = (i: number): RecordedStep => ({ kind: "click", role: "button", name: `b${i}`, value: "", at: i });

describe("appendStep", () => {
  it("keeps the newest steps once the host's cap is reached", () => {
    let steps: RecordedStep[] = [];
    for (let i = 0; i < STEP_CAP + 3; i += 1) steps = appendStep(steps, step(i));
    expect(steps).toHaveLength(STEP_CAP);
    expect(steps[0]?.name).toBe("b3");
    expect(steps.at(-1)?.name).toBe(`b${STEP_CAP + 2}`);
  });
});

describe("recorder start", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useBrowser.setState({ error: null });
  });

  it("says why a start failed to subscribe, and subscribes again on the next one", async () => {
    const listen = vi.spyOn(events.recorderEvent, "listen")
      .mockRejectedValueOnce(new Error("recorder events unavailable"))
      .mockResolvedValue(() => undefined);
    const start = vi.spyOn(ipc, "tabRecordStart").mockResolvedValue(null);
    await useRecorder.getState().start("a");
    expect(useBrowser.getState().error).toBe("recorder events unavailable");
    expect(start).not.toHaveBeenCalled();
    await useRecorder.getState().start("a");
    await useRecorder.getState().start("a");
    expect(start).toHaveBeenCalledTimes(2);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(useRecorder.getState().recordingTab).toBe("a");
  });
});

describe("recorder stop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useRecorder.setState({ recordingTab: null, steps: [], isOpen: false });
  });

  it("prefers the host's steps, and keeps the collected ones when the host has none", () => {
    expect(finalSteps([step(1)], [step(2), step(3)])).toEqual([step(1)]);
    expect(finalSteps([], [step(2), step(3)])).toEqual([step(2), step(3)]);
  });

  it("shows the steps of a tab that closed while recording", async () => {
    // Closing the tab made the host forget its copy; its empty answer used
    // to replace what the chrome had collected.
    vi.spyOn(ipc, "tabRecordStop").mockResolvedValue([]);
    useRecorder.setState({ recordingTab: "a", steps: [step(1), step(2)] });
    await useRecorder.getState().stop();
    expect(useRecorder.getState()).toMatchObject({ recordingTab: null, isOpen: true });
    expect(useRecorder.getState().steps).toHaveLength(2);
  });
});
