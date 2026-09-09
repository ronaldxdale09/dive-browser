import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useEmulation } from "../store/emulation";
import { useRecording } from "../store/recording";
import { COLLAPSE_BELOW, FeatureBar } from "./FeatureBar";
import { usePicker } from "./simulator/DevicePicker";
import { useUpdates } from "../store/updates";

const tab: Tab = {
  id: "tab-1",
  workspace_id: "workspace-1",
  tier: "today",
  url: "https://example.com/docs",
  title: "Example",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-03T00:00:00Z",
};

beforeEach(() => {
  useBrowser.setState({
    tabs: [tab],
    activeTab: tab.id,
    activeWorkspace: tab.workspace_id,
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, shortcuts: false, menu: false, defaultBrowser: false, subtitles: false },
    error: null,
    notice: null,
    recordingTab: null,
  });
  useEmulation.setState({ byTab: {}, media: {}, throttle: {} });
  usePicker.setState({ open: false });
  useRecording.setState({ phase: "idle", tab: null, result: null, error: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
  vi.spyOn(ipc, "tabScreencastStart").mockResolvedValue(null);
  vi.spyOn(ipc, "tabScreencastPause").mockResolvedValue(null);
  vi.spyOn(ipc, "tabScreencastCancel").mockResolvedValue(null);
  vi.spyOn(ipc, "recordingCapabilities").mockResolvedValue({ ffmpeg: true, microphones: [], video_max_seconds: 600, gif_max_seconds: 60 });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  useUpdates.setState({ status: "idle", update: null, error: null, installing: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FeatureBar", () => {
  it("shows an update pill only when a newer build waits, and opens About", () => {
    const { rerender } = render(<FeatureBar />);
    expect(screen.queryByRole("button", { name: "Update available" })).toBeNull();
    act(() => useUpdates.setState({ status: "available", update: { version: "0.2.0", notes: null } }));
    rerender(<FeatureBar />);
    fireEvent.click(screen.getByRole("button", { name: "Update available" }));
    expect(useBrowser.getState().open.settings).toBe(true);
    expect(useBrowser.getState().settingsSection).toBe("about");
  });

  it("keeps only the agent and Apps in the bar, each with a tooltip, and Apps opens the launcher", () => {
    render(<FeatureBar />);
    for (const word of ["Agent", "Apps"]) expect(screen.getAllByText(word).length).toBeGreaterThan(0);
    // Capture, the device simulator and the developer surfaces live in Apps.
    for (const gone of ["Capture", "Mobile", "Downloads", "DEV"]) expect(screen.queryByText(gone)).toBeNull();
    const apps = screen.getByRole("button", { name: "Apps: everything Dive can do" });
    const tooltip = document.getElementById(apps.getAttribute("aria-describedby") ?? "");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    fireEvent.click(apps);
    expect(useBrowser.getState().open.apps).toBe(true);
  });

  it("shows the recording's controls in the bar once one runs", async () => {
    render(<FeatureBar />);
    expect(screen.queryByRole("timer")).toBeNull();
    useRecording.getState().openSetup();
    expect(useRecording.getState().phase).toBe("setup");
    expect(useRecording.getState().tab).toBe(tab.id);

    // Straight to recording, no countdown: the bar becomes the controls.
    useRecording.getState().setSettings({ countdown: false, format: "gif", microphone: null });
    await act(() => useRecording.getState().start());
    await waitFor(() => expect(ipc.tabScreencastStart).toHaveBeenCalledWith(tab.id, expect.objectContaining({ format: "gif" })));
    expect(useBrowser.getState().recordingTab).toBe(tab.id);
    expect(screen.getByRole("button", { name: "Stop and save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause recording" })).toBeTruthy();
    // The running clock is a timer, so assistive tech knows a recording is in progress.
    expect(screen.getByRole("timer").getAttribute("aria-label")).toMatch(/recorded$/);

    await act(() => useRecording.getState().pause());
    expect(screen.getByRole("button", { name: "Resume recording" })).toBeTruthy();
    expect(ipc.tabScreencastPause).toHaveBeenCalledWith(tab.id, true);

    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
    await waitFor(() => expect(useRecording.getState().phase).toBe("idle"));
    expect(useBrowser.getState().recordingTab).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
  });

  it("opens the agent", () => {
    render(<FeatureBar />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(useBrowser.getState().open.sidecar).toBe(true);
  });

  it("drops the labels to icons when the title bar is narrow, and brings them back", () => {
    // A ResizeObserver whose callbacks the test can fire with a chosen width.
    const callbacks: ResizeObserverCallback[] = [];
    const Observer = class {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    vi.stubGlobal("ResizeObserver", Observer);
    const resize = (width: number) => act(() => callbacks.forEach((cb) => cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)));

    render(<FeatureBar />);
    const agent = () => screen.getByRole("button", { name: "Agent" });
    expect(screen.getByText("Apps")).toBeTruthy();
    expect(agent().textContent).toContain("Agent");

    resize(COLLAPSE_BELOW - 100);
    expect(screen.queryByText("Apps")).toBeNull();
    expect(agent().textContent).not.toContain("Agent");
    // Every action is still there by name.
    expect(screen.getByRole("button", { name: "Apps: everything Dive can do" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent" })).toBeTruthy();

    resize(COLLAPSE_BELOW + 300);
    expect(screen.getByText("Apps")).toBeTruthy();
    expect(agent().textContent).toContain("Agent");
    vi.unstubAllGlobals();
  });
});
