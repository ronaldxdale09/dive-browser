import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { scheduleControlsReady, startStartupTelemetry } from "./startup";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn().mockResolvedValue(undefined),
}));

let paint: (names: string[]) => void;
let disconnected: boolean;
let observed: PerformanceObserverInit | undefined;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  window.history.replaceState({}, "", "/");
  disconnected = false;
  observed = undefined;
  paint = () => {};
  vi.stubGlobal("PerformanceObserver", class {
    constructor(callback: PerformanceObserverCallback) {
      paint = (names) => callback({ getEntries: () => names.map((name) => ({ name })) } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
    }
    observe(options: PerformanceObserverInit) { observed = options; }
    disconnect() { disconnected = true; }
  });
  stop = startStartupTelemetry();
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

describe("startup observations", () => {
  it("reports actual buffered contentful paint once without a renderer clock", async () => {
    expect(observed).toEqual({ type: "paint", buffered: true });
    paint(["first-paint"]);
    expect(invoke).not.toHaveBeenCalled();
    paint(["first-contentful-paint"]);
    paint(["first-contentful-paint"]);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("report_startup_milestone", { milestone: "chrome_first_paint" });
    expect(disconnected).toBe(true);
  });

  it("waits for both paint acknowledgement and a rendered controls frame", async () => {
    let acknowledge = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    paint(["first-contentful-paint"]);
    scheduleControlsReady();
    await vi.advanceTimersByTimeAsync(40);
    expect(invoke).toHaveBeenCalledTimes(1);
    acknowledge();
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenLastCalledWith("report_startup_milestone", { milestone: "controls_ready" });
  });

  it("does not synthesize paint from controls readiness or elapsed time", async () => {
    scheduleControlsReady();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels controls work on cleanup and ignores observer callbacks after disposal", async () => {
    const cancel = scheduleControlsReady();
    cancel();
    paint(["first-contentful-paint"]);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
    expect(disconnected).toBe(true);
    paint(["first-contentful-paint"]);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("revokes rendered controls while paint acknowledgement is still pending", async () => {
    let acknowledge = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    paint(["first-contentful-paint"]);
    const cancel = scheduleControlsReady();
    await vi.advanceTimersByTimeAsync(40);
    cancel();
    acknowledge();
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not let an older cleanup revoke a newer controls observation", async () => {
    let acknowledge = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    paint(["first-contentful-paint"]);
    const cancelOld = scheduleControlsReady();
    await vi.advanceTimersByTimeAsync(40);
    const cancelNew = scheduleControlsReady();
    await vi.advanceTimersByTimeAsync(40);
    cancelOld();
    acknowledge();
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenLastCalledWith("report_startup_milestone", { milestone: "controls_ready" });
    cancelNew();
  });

  it("never observes or reports a popout document", async () => {
    stop();
    observed = undefined;
    vi.mocked(invoke).mockClear();
    window.history.replaceState({}, "", "/?popout=tab-1");
    stop = startStartupTelemetry();
    scheduleControlsReady();
    await vi.runAllTimersAsync();
    expect(observed).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
