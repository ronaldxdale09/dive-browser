import { afterEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import type { RecordedStep } from "../lib/ipc";
import { useBrowser } from "./browser";
import { appendStep, STEP_CAP, useRecorder } from "./recorder";

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
