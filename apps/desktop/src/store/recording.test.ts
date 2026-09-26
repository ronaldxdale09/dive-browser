import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { tabInThisWindow, useBrowser } from "./browser";
import type { RecordingResult } from "../lib/ipc";
import { applyRecordingEvent, DEFAULT_SETTINGS, describeLimits, effectiveSettings, elapsedSeconds, recordedTabClosed, useRecording } from "./recording";

const caps = { ffmpeg: true, microphones: [{ id: "0", name: "Built-in" }], video_max_seconds: 600, gif_max_seconds: 60 };

beforeEach(() => {
  useBrowser.setState({ activeTab: "tab-1", detached: [], recordingTab: null, error: null });
  useRecording.setState({ phase: "idle", tab: null, error: null, result: null, progress: null, micRequested: false, micFailed: false, limitHit: false, settings: { ...DEFAULT_SETTINGS, countdown: false }, startedAt: null, pausedAt: null, pausedTotal: 0 });
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

describe("recording setup target", () => {
  it("does not start setup on a detached tab as this window's", () => {
    useBrowser.setState({ activeTab: "tab-1", detached: ["tab-1"] });
    expect(tabInThisWindow(useBrowser.getState().activeTab, useBrowser.getState().detached)).toBeNull();
    useRecording.getState().openSetup();
    expect(useRecording.getState().phase).toBe("idle");
    expect(useRecording.getState().tab).toBeNull();
  });

  it("starts setup on a named tab even when that tab is detached", () => {
    useBrowser.setState({ activeTab: "tab-1", detached: ["tab-1"] });
    useRecording.getState().openSetup("tab-1");
    expect(useRecording.getState().phase).toBe("setup");
    expect(useRecording.getState().tab).toBe("tab-1");
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

  it("ends a failed stop in a state that says so, and a second try saves", async () => {
    const stop = vi.spyOn(ipc, "tabScreencastStop").mockRejectedValueOnce(new Error("Encoder did not respond")).mockResolvedValueOnce(saved);
    useBrowser.setState({ recordingTab: "tab-1" });
    useRecording.setState({ phase: "recording", tab: "tab-1", startedAt: Date.now() });

    await useRecording.getState().stop();

    // Capture is over, so no ticking clock or pause: a failure to act on.
    expect(useRecording.getState()).toMatchObject({ phase: "failed", tab: "tab-1", error: "Encoder did not respond" });
    expect(useBrowser.getState().recordingTab).toBe("tab-1");
    expect(useBrowser.getState().error).toBeNull();

    await useRecording.getState().stop();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(useRecording.getState()).toMatchObject({ phase: "done", result: saved, error: null });
    expect(useBrowser.getState().recordingTab).toBeNull();
  });

  it("gives up on a retry the engine holds nothing for", async () => {
    vi.spyOn(ipc, "tabScreencastStop").mockRejectedValue(new Error("not recording this tab"));
    useRecording.setState({ phase: "failed", tab: "tab-1", error: "nothing was painted while recording" });
    await useRecording.getState().stop();
    expect(useRecording.getState()).toMatchObject({ phase: "idle", tab: null });
    expect(useBrowser.getState().error).toMatch(/Nothing was captured/);
  });

  it("throws a failed recording away", async () => {
    const cancel = vi.spyOn(ipc, "tabScreencastCancel").mockResolvedValue(null);
    useRecording.setState({ phase: "failed", tab: "tab-1", error: "disk full" });
    await useRecording.getState().cancel();
    expect(cancel).toHaveBeenCalledWith("tab-1");
    expect(useRecording.getState()).toMatchObject({ phase: "idle", tab: null, error: null });
  });

  it("stops a save without throwing the recording away", async () => {
    const cancel = vi.spyOn(ipc, "tabScreencastCancel").mockResolvedValue(null);
    useRecording.setState({ phase: "finishing", tab: "tab-1" });
    await useRecording.getState().cancel();
    expect(cancel).toHaveBeenCalledWith("tab-1");
    // The pending stop (or the engine's event) moves it on; nothing here resets it.
    expect(useRecording.getState()).toMatchObject({ phase: "finishing", tab: "tab-1" });
  });
});

const saved: RecordingResult = { path: "/captures/a.mp4", duration_secs: 3, bytes: 1000, width: 640, height: 360, format: "mp4", frames: 90, has_audio: false, events: null, preview: null };
const event = (kind: string, extra: Partial<Parameters<typeof applyRecordingEvent>[0]> = {}) => ({ tab: "tab-1", kind, progress: null, result: null, error: null, ...extra });

describe("recorded tab closing", () => {
  it("hands a running recording to the engine's save instead of calling it discarded", () => {
    useRecording.setState({ phase: "recording", tab: "tab-1", startedAt: Date.now() });
    recordedTabClosed("tab-1");
    expect(useRecording.getState().phase).toBe("finishing");
    expect(useBrowser.getState().error).toBeNull();

    applyRecordingEvent(event("progress", { progress: 0.5 }));
    expect(useRecording.getState().progress).toBe(0.5);
    applyRecordingEvent(event("saved", { result: saved }));
    expect(useRecording.getState()).toMatchObject({ phase: "done", result: saved });
  });

  it("leaves a save already under way alone", () => {
    useRecording.setState({ phase: "finishing", tab: "tab-1" });
    recordedTabClosed("tab-1");
    expect(useRecording.getState()).toMatchObject({ phase: "finishing", tab: "tab-1" });
    expect(useBrowser.getState().error).toBeNull();
  });

  it("says nothing was recorded when the tab closes before capture began", () => {
    useRecording.setState({ phase: "countdown", tab: "tab-1", countdown: 2 });
    recordedTabClosed("tab-1");
    expect(useRecording.getState()).toMatchObject({ phase: "idle", tab: null });
    expect(useBrowser.getState().error).toMatch(/before recording began/);
  });

  it("ignores other tabs", () => {
    useRecording.setState({ phase: "recording", tab: "tab-1", startedAt: Date.now() });
    recordedTabClosed("tab-2");
    expect(useRecording.getState().phase).toBe("recording");
  });
});

describe("engine recording events", () => {
  it("shows a save the engine began itself, and its failure", () => {
    useRecording.setState({ phase: "paused", tab: "tab-1", startedAt: Date.now(), pausedAt: Date.now() });
    applyRecordingEvent(event("finishing"));
    expect(useRecording.getState().phase).toBe("finishing");
    applyRecordingEvent(event("failed", { error: "ffmpeg timed out" }));
    expect(useRecording.getState()).toMatchObject({ phase: "failed", error: "ffmpeg timed out" });
  });

  it("remembers a lost microphone for the saved dialog", () => {
    useRecording.setState({ phase: "recording", tab: "tab-1", startedAt: Date.now(), micRequested: true });
    applyRecordingEvent(event("mic_failed"));
    expect(useRecording.getState().micFailed).toBe(true);
    applyRecordingEvent({ ...event("mic_failed"), tab: "tab-2" });
    expect(useRecording.getState().phase).toBe("recording");
  });

  it("stops at the length cap", async () => {
    const stop = vi.spyOn(ipc, "tabScreencastStop").mockResolvedValue(saved);
    useRecording.setState({ phase: "recording", tab: "tab-1", startedAt: Date.now() });
    applyRecordingEvent(event("limit"));
    expect(useRecording.getState().limitHit).toBe(true);
    await vi.waitFor(() => expect(useRecording.getState().phase).toBe("done"));
    expect(stop).toHaveBeenCalledWith("tab-1");
  });
});
