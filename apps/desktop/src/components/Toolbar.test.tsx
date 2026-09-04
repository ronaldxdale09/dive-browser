import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useDownloads } from "../store/downloads";
import { useEmulation } from "../store/emulation";
import { useNetwork } from "../store/network";
import { usePrivacy } from "../store/privacy";
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
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, shortcuts: false },
    error: null,
    notice: null,
    annotating: null,
    recordingTab: null,
    zoom: {},
    loading: {},
  });
  useEmulation.setState({ byTab: {}, media: {}, throttle: {} });
  useDownloads.setState({ items: [] });
  useNetwork.setState({ byTab: {}, frames: {} });
  usePrivacy.setState({
    byTab: {},
    info: { version: "2026.09.04", ad_rules: 63, tracker_rules: 62, cosmetic_hosts: 4 },
  });
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
  vi.spyOn(ipc, "tabStop").mockResolvedValue(null);
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

  it("renders the local guardian and an honest clean, globally-off state", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));

    const dialog = screen.getByRole("dialog", { name: "DivePrivacy protection" });
    expect(dialog.className).toContain("w-[360px]");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("DivePrivacy is off")).toBeTruthy();
    expect(screen.getByText("Clean so far")).toBeTruthy();
    expect(screen.getByAltText("Dive Privacy guardian").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByTestId("privacy-halo")).toBeTruthy();
    expect(screen.getByText("Ads blocked").nextSibling?.textContent).toBe("0");
    expect(screen.getByText("Trackers stopped").nextSibling?.textContent).toBe("0");
    expect(screen.getByText("YouTube protection").nextSibling?.textContent).toBe("Unavailable here");
    expect(screen.getByText("Rules 2026.09.04")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Protection on this site" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("switch", { name: "DivePrivacy protection" }).getAttribute("aria-checked")).toBe("false");
  });

  it("reports typed per-layer counts without treating generic network failures as privacy actions", () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    usePrivacy.setState({ byTab: { [tab.id]: { ads: 2, trackers: 1, youtube: 0 } } });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));

    expect(screen.getByText("Protected on this site")).toBeTruthy();
    expect(screen.getByText("3 stopped so far")).toBeTruthy();
    expect(screen.getByTestId("privacy-halo").className).toContain("privacy-halo");
    expect(screen.getByText("Ads blocked").nextSibling?.textContent).toBe("2");
    expect(screen.getByText("Trackers stopped").nextSibling?.textContent).toBe("1");
    expect(screen.getByLabelText("3 blocked on this page")).toBeTruthy();
  });

  it("persists an exact-host pause before reloading the active tab", async () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    let finishWrite!: (prefs: typeof DEFAULT_PREFS) => void;
    vi.mocked(ipc.prefsSet).mockReturnValueOnce(new Promise((resolve) => (finishWrite = resolve)));

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    fireEvent.click(screen.getByRole("switch", { name: "Protection on this site" }));

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["example.com"] }));
    expect(ipc.tabReload).not.toHaveBeenCalled();

    finishWrite({ ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["example.com"] });
    await waitFor(() => expect(ipc.tabReload).toHaveBeenCalledWith(tab.id));
    expect(screen.getByText("Protection paused here")).toBeTruthy();
  });

  it("removes only the active exact host when protection resumes", async () => {
    usePrefs.setState({
      prefs: { ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["other.example", "example.com"] },
      loaded: true,
    });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    const site = screen.getByRole("switch", { name: "Protection on this site" });
    expect(site.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(site);

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["other.example"] }));
    await waitFor(() => expect(ipc.tabReload).toHaveBeenCalledWith(tab.id));
  });

  it("offers global enablement when DivePrivacy is off", async () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    fireEvent.click(screen.getByRole("switch", { name: "DivePrivacy protection" }));

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true }));
    expect(screen.queryByRole("switch", { name: "DivePrivacy protection" })).toBeNull();
    expect(screen.getByText("Protected on this site")).toBeTruthy();
  });

  it("shows and changes YouTube protection only on supported YouTube hosts", async () => {
    useBrowser.setState({ tabs: [{ ...tab, url: "https://www.youtube.com/watch?v=abc" }] });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    usePrivacy.setState({ byTab: { [tab.id]: { ads: 0, trackers: 0, youtube: 2 } } });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    expect(screen.getByText("YouTube protection").nextSibling?.textContent).toBe("Active");
    const youtube = screen.getByRole("switch", { name: "YouTube protection" });
    expect(youtube.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(youtube);

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true, youtube_protection: false }));
    expect(screen.getByText("YouTube protection").nextSibling?.textContent).toBe("Inactive");
  });

  it.each(["dive://screen", "not a valid URL"])("disables host-specific controls for %s", (url) => {
    useBrowser.setState({ tabs: [{ ...tab, url }] });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));

    expect((screen.getByRole("switch", { name: "Protection on this site" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Site controls unavailable")).toBeTruthy();
  });

  it("does not reload when preference persistence fails", async () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    vi.mocked(ipc.prefsSet).mockRejectedValueOnce(new Error("disk full"));

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    fireEvent.click(screen.getByRole("switch", { name: "Protection on this site" }));

    await waitFor(() => expect(useBrowser.getState().error).toBe("disk full"));
    expect(usePrefs.getState().prefs.privacy_exceptions).toEqual([]);
    expect(ipc.tabReload).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to the protection trigger", async () => {
    render(<Toolbar />);
    const trigger = screen.getByRole("button", { name: "Protection" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "DivePrivacy protection" });
    expect(dialog.className).toContain("privacy-motion");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "DivePrivacy protection" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("opens all privacy settings from the card footer", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    fireEvent.click(screen.getByRole("button", { name: "All privacy settings" }));

    expect(useBrowser.getState().open.settings).toBe(true);
    expect(useBrowser.getState().settingsSection).toBe("privacy");
    expect(screen.queryByRole("dialog", { name: "DivePrivacy protection" })).toBeNull();
  });

  it("draws a progress line under the toolbar while the active tab loads", () => {
    render(<Toolbar />);
    expect(screen.queryByRole("progressbar")).toBeNull();

    act(() => useBrowser.getState().applyLoad({ tab_id: tab.id, phase: "started", url: tab.url, error: null }));
    const bar = screen.getByRole("progressbar", { name: "Loading page" });
    expect(bar.className).toContain("h-0.5");
    expect(screen.getByTestId("loading-sweep").className).toContain("motion-reduce:animate-none");

    // Another tab's load is not this toolbar's business.
    act(() => {
      useBrowser.getState().applyLoad({ tab_id: "elsewhere", phase: "started", url: null, error: null });
      useBrowser.getState().applyLoad({ tab_id: tab.id, phase: "stopped", url: tab.url, error: null });
    });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("turns reload into stop while the page loads", async () => {
    render(<Toolbar />);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    act(() => useBrowser.getState().applyLoad({ tab_id: tab.id, phase: "started", url: tab.url, error: null }));
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop loading" }));
    await waitFor(() => expect(ipc.tabStop).toHaveBeenCalledWith(tab.id));
    act(() => useBrowser.getState().applyLoad({ tab_id: tab.id, phase: "stopped", url: tab.url, error: null }));
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop loading" })).toBeNull();
  });

  it("moves secondary actions into a tray in compact chrome", () => {
    render(<Toolbar compact />);

    expect(screen.queryByRole("button", { name: "Capture full page" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More page actions" }));
    expect(screen.getByRole("dialog", { name: "Page actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Capture full page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open DevTools" })).toBeTruthy();
  });
});
