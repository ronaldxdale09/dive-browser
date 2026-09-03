import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useEmulation } from "../store/emulation";
import { FeatureBar } from "./FeatureBar";
import { usePicker } from "./simulator/DevicePicker";

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
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false },
    error: null,
    notice: null,
    annotating: null,
    recordingTab: null,
  });
  useEmulation.setState({ byTab: {}, media: {}, throttle: {} });
  usePicker.setState({ open: false });
  vi.spyOn(ipc, "tabScreencastStart").mockResolvedValue(null);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FeatureBar", () => {
  it("names record, the emulator and the agent, and keeps a tooltip on each", () => {
    render(<FeatureBar />);
    for (const word of ["Record", "Mobile", "Agent"]) expect(screen.getAllByText(word).length).toBeGreaterThan(0);
    // Page actions live beside the URL, not up here.
    expect(screen.queryByText("Capture")).toBeNull();
    expect(screen.queryByText("Downloads")).toBeNull();
    const record = screen.getByRole("button", { name: "Record tab as GIF" });
    const tooltip = document.getElementById(record.getAttribute("aria-describedby") ?? "");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
  });

  it("starts and stops recording the active tab", async () => {
    render(<FeatureBar />);
    fireEvent.click(screen.getByRole("button", { name: "Record tab as GIF" }));
    await waitFor(() => expect(ipc.tabScreencastStart).toHaveBeenCalledWith(tab.id));
    expect(useBrowser.getState().recordingTab).toBe(tab.id);
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeTruthy();
  });

  it("opens the device menu, agent and all-tabs surfaces", () => {
    render(<FeatureBar />);
    fireEvent.click(screen.getByRole("button", { name: "Device simulator" }));
    expect(usePicker.getState().open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    const { open } = useBrowser.getState();
    expect(open.sidecar).toBe(true);
    expect(open.palette).toBe(true);
  });
});
