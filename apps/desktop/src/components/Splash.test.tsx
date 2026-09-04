import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { invoke } from "@tauri-apps/api/core";
import { startStartupTelemetry } from "../lib/startup";
import { SPLASH_DELAY_MS, SPLASH_MIN_VISIBLE_MS, SPLASH_FADE_MS, Splash } from "./Splash";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(),
  invoke: vi.fn().mockResolvedValue(undefined),
}));
let stopStartup = () => {};
function observePaint() {
  let reportPaint = () => {};
  vi.stubGlobal("PerformanceObserver", class {
    constructor(callback: PerformanceObserverCallback) {
      reportPaint = () => callback({ getEntries: () => [{ name: "first-contentful-paint" }] } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
    }
    observe() {}
    disconnect() {}
  });
  stopStartup = startStartupTelemetry();
  reportPaint();
}

beforeEach(() => {
  vi.useFakeTimers();
  useBrowser.setState({ ready: false, error: null });
  vi.mocked(invoke).mockClear();
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  stopStartup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Splash", () => {
  it("never paints for a boot that completes inside the delay", () => {
    render(<Splash />);
    act(() => vi.advanceTimersByTime(SPLASH_DELAY_MS - 1));
    expect(screen.queryByText("Starting engine")).toBeNull();
    act(() => useBrowser.setState({ ready: true }));
    act(() => vi.runAllTimers());
    expect(screen.queryByText("Starting engine")).toBeNull();
  });

  it("appears only when startup actually takes time", () => {
    render(<Splash />);
    expect(screen.queryByText("Starting engine")).toBeNull();
    act(() => vi.advanceTimersByTime(SPLASH_DELAY_MS));
    expect(screen.getByText("Starting engine")).toBeTruthy();
  });

  it("reports controls after a successful fast boot has rendered", async () => {
    observePaint();
    render(<Splash />);
    act(() => useBrowser.setState({ ready: true }));
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(invoke).toHaveBeenLastCalledWith("report_startup_milestone", { milestone: "controls_ready" });
  });

  it("waits until the visible splash has fully faded and the next frame rendered", async () => {
    observePaint();
    render(<Splash />);
    act(() => vi.advanceTimersByTime(SPLASH_DELAY_MS));
    act(() => useBrowser.setState({ ready: true }));
    await act(() => vi.advanceTimersByTimeAsync(SPLASH_MIN_VISIBLE_MS + SPLASH_FADE_MS - 1));
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Starting engine")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(invoke).toHaveBeenLastCalledWith("report_startup_milestone", { milestone: "controls_ready" });
  });

  it("does not report usable controls when snapshot initialization failed", async () => {
    observePaint();
    useBrowser.setState({ ready: true, error: "snapshot failed" });
    render(<Splash />);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(invoke).toHaveBeenCalledTimes(1);
    // Dismissing the error is not a successful snapshot response.
    act(() => useBrowser.setState({ error: null }));
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("cancels readiness work when the chrome unmounts", async () => {
    observePaint();
    useBrowser.setState({ ready: true });
    const view = render(<Splash />);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("revokes rendered controls on unmount before a delayed paint acknowledgement", async () => {
    let acknowledge = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    observePaint();
    useBrowser.setState({ ready: true });
    const view = render(<Splash />);
    await act(() => vi.advanceTimersByTimeAsync(40));
    view.unmount();
    acknowledge();
    await act(() => vi.runAllTimersAsync());
    expect(invoke).toHaveBeenCalledTimes(1);
  });

});
