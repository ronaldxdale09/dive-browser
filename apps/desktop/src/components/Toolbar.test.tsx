import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useEmulation } from "../store/emulation";
import { Toolbar } from "./Toolbar";

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
    zoom: {},
  });
  useEmulation.setState({ byTab: {}, media: {}, throttle: {} });

  vi.spyOn(ipc, "bookmarkStatus").mockResolvedValue(false);
  vi.spyOn(ipc, "bookmarkToggle").mockResolvedValue(true);
  vi.spyOn(ipc, "shareUrl").mockResolvedValue({
    lan_url: "https://example.com/docs",
    qr_svg: "<svg></svg>",
  });
  vi.spyOn(ipc, "tabBack").mockResolvedValue(null);
  vi.spyOn(ipc, "tabForward").mockResolvedValue(null);
  vi.spyOn(ipc, "tabReload").mockResolvedValue(null);
  vi.spyOn(ipc, "tabCapture").mockResolvedValue("/tmp/capture.png");
  vi.spyOn(ipc, "tabScreencastStart").mockResolvedValue(null);
  vi.spyOn(ipc, "tabDevtools").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Toolbar", () => {
  it("associates every button around the address field with a custom tooltip", () => {
    render(<Toolbar />);

    const labels = [
      "Back",
      "Forward",
      "Reload",
      "Bookmark this page",
      "Share to another device",
      "Capture full page",
      "Record tab as GIF",
      "Device simulator",
      "Open DevTools",
      "Developer dock",
      "Agent",
    ];

    for (const label of labels) {
      const button = screen.getByRole("button", { name: label });
      const tooltip = document.getElementById(button.getAttribute("aria-describedby") ?? "");
      expect(tooltip?.getAttribute("role")).toBe("tooltip");
      expect(tooltip?.textContent).toContain(label);
      expect(button.getAttribute("title")).toBeNull();
    }
  });

  it("routes clicks to navigation, bookmark, capture, recording and DevTools actions", async () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Capture full page" }));
    fireEvent.click(screen.getByRole("button", { name: "Record tab as GIF" }));
    fireEvent.click(screen.getByRole("button", { name: "Open DevTools" }));

    await waitFor(() => {
      expect(ipc.tabBack).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabForward).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabReload).toHaveBeenCalledWith(tab.id);
      expect(ipc.bookmarkToggle).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabCapture).toHaveBeenCalledWith(tab.id, true);
      expect(ipc.tabScreencastStart).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabDevtools).toHaveBeenCalledWith(tab.id);
      expect(useBrowser.getState().annotating).toBe("/tmp/capture.png");
      expect(useBrowser.getState().recordingTab).toBe(tab.id);
    });
  });

  it("opens the share dialog, device menu, developer dock and agent surface", () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "Share to another device" }));
    expect(screen.getByRole("dialog", { name: "Share" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Device simulator" }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Developer dock" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(useBrowser.getState().open.dock).toBe(true);
    expect(useBrowser.getState().open.sidecar).toBe(true);
  });
});
