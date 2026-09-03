import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useDownloads } from "../store/downloads";
import { useEmulation } from "../store/emulation";
import { useNetwork } from "../store/network";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
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
  useDownloads.setState({ items: [] });
  useNetwork.setState({ byTab: {}, frames: {} });
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "downloadsReveal").mockResolvedValue(null);
  vi.spyOn(ipc, "prefsSet").mockImplementation((p) => Promise.resolve(p));
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

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
      "Open DevTools",
      "Developer dock",
      "Downloads",
      "Protection",
    ];

    for (const label of labels) {
      const button = screen.getByRole("button", { name: label });
      const tooltip = document.getElementById(button.getAttribute("aria-describedby") ?? "");
      expect(tooltip?.getAttribute("role")).toBe("tooltip");
      expect(tooltip?.textContent).toContain(label);
      expect(button.getAttribute("title")).toBeNull();
    }
  });

  it("routes clicks to navigation, bookmark, capture and DevTools actions", async () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Capture full page" }));
    fireEvent.click(screen.getByRole("button", { name: "Open DevTools" }));

    await waitFor(() => {
      expect(ipc.tabBack).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabForward).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabReload).toHaveBeenCalledWith(tab.id);
      expect(ipc.bookmarkToggle).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabCapture).toHaveBeenCalledWith(tab.id, true);
      expect(ipc.tabDevtools).toHaveBeenCalledWith(tab.id);
      expect(useBrowser.getState().annotating).toBe("/tmp/capture.png");
    });
  });

  it("opens the share dialog and the developer dock", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Share to another device" }));
    expect(screen.getByRole("dialog", { name: "Share" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Developer dock" }));
    expect(useBrowser.getState().open.dock).toBe(true);
  });

  it("lists downloads and reveals a finished one", () => {
    useDownloads.setState({
      items: [
        { url: "https://cdn.example.com/report.pdf", path: "/Users/me/Downloads/report.pdf", name: "report.pdf", status: "finished", at: Date.now() },
        { url: "https://cdn.example.com/big.zip", path: "/Users/me/Downloads/big.zip", name: "big.zip", status: "started", at: Date.now() },
      ],
    });
    render(<Toolbar />);
    expect(screen.getByLabelText("1 in progress")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    expect(screen.getByRole("dialog", { name: "Downloads" })).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show report.pdf in folder" }));
    expect(ipc.downloadsReveal).toHaveBeenCalledWith("/Users/me/Downloads/report.pdf");
    fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
    expect(ipc.downloadsReveal).toHaveBeenCalledWith(null);
  });

  it("turns tracker blocking on from the protection menu and counts what it blocked", async () => {
    useNetwork.setState({
      byTab: {
        [tab.id]: [
          { id: "1", url: "https://www.google-analytics.com/g.js", method: "GET", resourceType: "Script", status: null, mimeType: "", fromCache: false, size: null, error: "net::ERR_BLOCKED_BY_CLIENT", startedAt: 0, durationMs: 4 },
          { id: "2", url: "https://example.com/app.js", method: "GET", resourceType: "Script", status: 200, mimeType: "text/javascript", fromCache: false, size: 10, error: null, startedAt: 0, durationMs: 40 },
        ],
      },
      frames: {},
    });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    expect(screen.getByText("Tracker blocking is off")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Block trackers and ads" }));
    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true }));
    expect(screen.getByText("1 request blocked on this page")).toBeTruthy();
  });
});
