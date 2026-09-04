import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "./browser";
import { DEFAULT_SETTINGS, describeLimits, effectiveSettings, elapsedSeconds, useRecording } from "./recording";

const caps = { ffmpeg: true, microphones: [{ id: "0", name: "Built-in" }], video_max_seconds: 600, gif_max_seconds: 60 };

beforeEach(() => {
  useBrowser.setState({ activeTab: "tab-1", recordingTab: null, error: null });
  useRecording.setState({ phase: "idle", tab: null, error: null, result: null, settings: { ...DEFAULT_SETTINGS, countdown: false }, startedAt: null, pausedAt: null, pausedTotal: 0 });
});

afterEach(() => vi.restoreAllMocks());

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

describe("recording command recovery", () => {
  it("locks the setup while start is in flight so one click creates one recorder", async () => {
    let finish!: () => void;
    const pending = new Promise<null>((resolve) => (finish = () => resolve(null)));
    const start = vi.spyOn(ipc, "tabScreencastStart").mockReturnValue(pending);
    useRecording.setState({ phase: "setup", tab: "tab-1" });

    const first = useRecording.getState().start();
    expect(useRecording.getState().phase).toBe("starting");
    const second = useRecording.getState().start();
    expect(start).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    expect(useRecording.getState().phase).toBe("recording");
  });

  it("returns to setup with a useful error when the selected tab cannot activate", async () => {
    useBrowser.setState({ activeTab: "another-tab", activateTab: vi.fn().mockRejectedValue(new Error("Tab process exited")) });
    const start = vi.spyOn(ipc, "tabScreencastStart").mockResolvedValue(null);
    useRecording.setState({ phase: "setup", tab: "tab-1" });

    await useRecording.getState().start();

    expect(start).not.toHaveBeenCalled();
    expect(useRecording.getState()).toMatchObject({ phase: "setup", error: "Tab process exited" });
  });

  it("does not claim pause or resume succeeded when the engine rejects it", async () => {
    vi.spyOn(ipc, "tabScreencastPause").mockRejectedValue(new Error("Recorder is unavailable"));
    useRecording.setState({ phase: "recording", tab: "tab-1", startedAt: Date.now() });
    await useRecording.getState().pause();
    expect(useRecording.getState()).toMatchObject({ phase: "recording", error: "Recorder is unavailable" });

    useRecording.setState({ phase: "paused", pausedAt: Date.now(), error: null });
    await useRecording.getState().resume();
    expect(useRecording.getState()).toMatchObject({ phase: "paused", error: "Recorder is unavailable" });
  });

  it("keeps a failed stop recoverable and offers another save attempt", async () => {
    vi.spyOn(ipc, "tabScreencastStop").mockRejectedValue(new Error("Encoder did not respond"));
    useBrowser.setState({ recordingTab: "tab-1" });
    useRecording.setState({ phase: "recording", tab: "tab-1", startedAt: Date.now() });

    await useRecording.getState().stop();

    expect(useRecording.getState()).toMatchObject({ phase: "recording", tab: "tab-1", error: "Encoder did not respond" });
    expect(useBrowser.getState().recordingTab).toBe("tab-1");
    expect(useBrowser.getState().error).toBeNull();
  });
});
