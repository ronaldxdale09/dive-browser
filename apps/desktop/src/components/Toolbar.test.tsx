import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { events, ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useDownloads } from "../store/downloads";
import { useEmulation } from "../store/emulation";
import { useNetwork } from "../store/network";
import { usePrivacy } from "../store/privacy";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { useSubtitles } from "../store/subtitles";
import { useRecorder } from "../store/recorder";
import { Toolbar } from "./Toolbar";
import { useShortcuts } from "../lib/shortcuts";

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
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, shortcuts: false, menu: false, defaultBrowser: false, extensions: false, subtitles: false },
    error: null,
    notice: null,
    capturing: false,
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
    infoError: null,
    eventError: null,
  });
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "downloadsReveal").mockResolvedValue(null);
  vi.spyOn(ipc, "prefsSet").mockImplementation((p) => Promise.resolve(p));
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

  vi.spyOn(ipc, "bookmarkStatus").mockResolvedValue(false);
  vi.spyOn(ipc, "bookmarkToggle").mockResolvedValue(true);
  vi.spyOn(ipc, "shareUrl").mockResolvedValue({
    lan_url: "https://example.com/docs",
    qr_svg: "<svg></svg>",
  });
  vi.spyOn(ipc, "tabBack").mockResolvedValue(null);
  vi.spyOn(ipc, "tabForward").mockResolvedValue(null);
  vi.spyOn(events.tabHistoryChanged, "listen").mockResolvedValue(() => {});
  vi.spyOn(ipc, "tabHistory").mockResolvedValue({
    generation: "view-1", current_index: 1, entries: [
      { id: 10, title: "Previous page", url: "https://example.com/previous" },
      { id: 20, title: "Current page", url: tab.url },
      { id: 30, title: "Next page", url: "https://example.com/next" },
    ],
  });
  vi.spyOn(ipc, "tabHistoryNavigate").mockResolvedValue(null);
  vi.spyOn(ipc, "tabReload").mockResolvedValue(null);
  vi.spyOn(ipc, "tabStop").mockResolvedValue(null);
  vi.spyOn(ipc, "tabOpen").mockResolvedValue(tab);
  vi.spyOn(ipc, "tabCapture").mockResolvedValue("/tmp/capture.png");
  vi.spyOn(ipc, "tabScreencastStart").mockResolvedValue(null);
  vi.spyOn(ipc, "tabDevtools").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Toolbar", () => {
  it("accepts the native address-focus handoff before immediate replacement typing", () => {
    vi.spyOn(events.menuCommand, "listen").mockResolvedValue(() => undefined);
    function NativeToolbar() { useShortcuts(); return <Toolbar />; }
    render(<NativeToolbar />);
    const input = screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
    act(() => window.dispatchEvent(new Event("dive-native-focus-address")));
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(tab.url);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, tab.url.length]);
    input.setRangeText("X", input.selectionStart!, input.selectionEnd!, "end");
    fireEvent.input(input);
    expect(input.value).toBe("X");
  });

  it("disables Back and Forward when the native history has a single entry", async () => {
    vi.mocked(ipc.tabHistory).mockResolvedValue({ generation: "view-1", current_index: 0, entries: [{ id: 1, title: "Only page", url: tab.url }] });
    render(<Toolbar />);
    await waitFor(() => expect(ipc.tabHistory).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens actual history with the keyboard and navigates using its generation and entry ID", async () => {
    render(<Toolbar />);
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    await waitFor(() => expect(back.disabled).toBe(false));
    act(() => back.focus());
    fireEvent.keyDown(back, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Back history" });
    expect(menu.contains(document.activeElement)).toBe(true);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole("menuitem", { name: /Previous page/ }));
    await waitFor(() => expect(ipc.tabHistoryNavigate).toHaveBeenCalledWith(tab.id, "view-1", 10));
    expect(screen.queryByRole("menu", { name: "Back history" })).toBeNull();
    expect(document.activeElement).toBe(back);
  });

  it("opens forward history on right-click and closes it with Escape", async () => {
    render(<Toolbar />);
    const forward = screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
    await waitFor(() => expect(forward.disabled).toBe(false));
    fireEvent.contextMenu(forward);
    expect(screen.getByRole("menuitem", { name: /Next page/ })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(forward);
  });

  it("shows and selects the complete URL when editing, including scheme and fragment", async () => {
    const url = "https://example.com/docs?q=hello#details";
    useBrowser.setState({ tabs: [{ ...tab, url }] });
    render(<Toolbar />);
    const input = screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
    act(() => input.focus());
    expect(input.value).toBe(url);
    await waitFor(() => {
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(url.length);
    });
  });

  it("goes home: hides the page without closing the tab", async () => {
    const deactivate = vi.spyOn(ipc, "tabDeactivate").mockResolvedValue(null);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    expect(useBrowser.getState().activeTab).toBeNull();
    expect(useBrowser.getState().tabs).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Home" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes to the configured home page instead of the welcome screen", async () => {
    usePrefs.setState({ prefs: { ...usePrefs.getState().prefs, homepage: "https://home.test/" } });
    const navigate = vi.spyOn(ipc, "tabNavigate").mockResolvedValue(null);
    const deactivate = vi.spyOn(ipc, "tabDeactivate").mockResolvedValue(null);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.anything(), "https://home.test/"));
    expect(deactivate).not.toHaveBeenCalled();
  });

  it("shows the zoom badge for a tab opened at the default zoom, and hides it at that default", () => {
    useBrowser.setState({ defaultZoom: 1.25 });
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: "Reset zoom" })).toBeNull();
    useBrowser.setState({ defaultZoom: 1 });
  });

  it("shows the address that failed to load, not the last one that worked", () => {
    useBrowser.setState({ navError: { [tab.id]: { url: "http://nonexistent.invalid/", error: "net::ERR_NAME_NOT_RESOLVED" } } });
    render(<Toolbar />);
    const input = screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
    expect(input.value).toBe("nonexistent.invalid");
    expect(document.querySelector("[data-security]")?.getAttribute("data-security")).toBe("failed");
    act(() => useBrowser.setState({ navError: {} }));
    expect(input.value).toBe("example.com/docs");
    expect(document.querySelector("[data-security]")?.getAttribute("data-security")).toBe("secure");
  });

  it("keeps typed text during a page redirect and Escape restores the current address", () => {
    render(<Toolbar />);
    const input = screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "my unfinished search" } });
    act(() => useBrowser.setState({ tabs: [{ ...tab, url: "https://example.com/redirected" }] }));
    expect(input.value).toBe("my unfinished search");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("example.com/redirected");
    expect(document.activeElement).not.toBe(input);
    expect(ipc.tabStop).not.toHaveBeenCalled();
  });

  it("resets the editable address when switching between tabs with the same URL", () => {
    render(<Toolbar />);
    const input = screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "old draft" } });
    act(() => useBrowser.setState({ tabs: [tab, { ...tab, id: "second" }], activeTab: "second" }));
    expect(input.value).toBe(tab.url);
  });

  it("covers native content for the compact tray and restores trigger focus on Escape", async () => {
    render(<Toolbar compact />);
    const trigger = screen.getByRole("button", { name: "More page actions" });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Page actions" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Page actions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false));
  });

  it("closes a nested Share popover without closing the compact actions tray", () => {
    render(<Toolbar compact />);
    fireEvent.click(screen.getByRole("button", { name: "More page actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Share to another device" }));
    const share = screen.getByRole("dialog", { name: "Share" });
    fireEvent.keyDown(share, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Share" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Page actions" })).toBeTruthy();
  });

  it("finishes editing after Enter so the final navigation URL replaces the submitted text", async () => {
    vi.spyOn(ipc, "tabNavigate").mockResolvedValue(null);
    render(<Toolbar />);
    const input = screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "example.com/start" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(ipc.tabNavigate).toHaveBeenCalledWith(tab.id, "example.com/start"));
    act(() => useBrowser.setState({ tabs: [{ ...tab, url: "https://example.com/final" }] }));
    expect(input.value).toBe("example.com/final");
    expect(document.activeElement).not.toBe(input);
  });

  it("reads the site first: host in ink, path dimmed, and a glyph that says what the connection is", async () => {
    useBrowser.setState({ tabs: [{ ...tab, url: "https://www.youtube.com/watch?v=abc" }] });
    render(<Toolbar />);
    const glyph = screen.getByRole("img", { name: "Secure connection" });
    expect(glyph.getAttribute("data-security")).toBe("secure");
    const input = screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
    expect(input.value).toBe("www.youtube.com/watch?v=abc");
    // The visible layer splits what the input holds whole.
    expect(screen.getByText("www.youtube.com").className).toContain("text-ink");
    expect(screen.getByText("/watch?v=abc").className).toContain("text-ink-3");
    act(() => input.focus());
    expect(input.className).toContain("text-ink");
    expect(screen.queryByText("/watch?v=abc")).toBeNull();
    act(() => useBrowser.setState({ tabs: [{ ...tab, url: "http://localhost:3000/" }] }));
    act(() => input.blur());
    expect(screen.getByRole("img", { name: /plain http/ })).toBeTruthy();
  });

  it("associates every button around the address field with a custom tooltip", () => {
    render(<Toolbar />);

    const labels = [
      "Back",
      "Forward",
      "Reload",
      "Bookmark this page",
      "Share to another device",
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

  it("routes clicks to navigation and bookmark actions", async () => {
    render(<Toolbar />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark this page" }));

    await waitFor(() => {
      expect(ipc.tabBack).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabForward).toHaveBeenCalledWith(tab.id);
      expect(ipc.tabReload).toHaveBeenCalledWith(tab.id);
      expect(ipc.bookmarkToggle).toHaveBeenCalledWith(tab.id);
    });
    // The developer surfaces, capture and downloads live in Apps now; the
    // bar beside the address is for the page alone.
    for (const gone of ["DevTools", "Developer dock", "Extensions", "Downloads", /capture/i]) expect(screen.queryByRole("button", { name: gone })).toBeNull();
  });

  it("shows that steps are being recorded and stops on a click", async () => {
    const stop = vi.spyOn(ipc, "tabRecordStop").mockResolvedValue([]);
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: "Stop recording steps" })).toBeNull();
    act(() => useRecorder.setState({ recordingTab: "t1" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording steps" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop recording steps" })).toBeNull());
  });

  it("shows that live subtitles are running and reopens their dialog", () => {
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: "Live subtitles on" })).toBeNull();
    act(() => useSubtitles.setState({ active: true }));
    fireEvent.click(screen.getByRole("button", { name: "Live subtitles on" }));
    expect(useBrowser.getState().open.subtitles).toBe(true);
    act(() => useSubtitles.setState({ active: false }));
    expect(screen.queryByRole("button", { name: "Live subtitles on" })).toBeNull();
  });

  it("opens the share dialog", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Share to another device" }));
    expect(screen.getByRole("dialog", { name: "Share" })).toBeTruthy();
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
    // Off means nothing is being counted, so the line invites turning it on.
    expect(screen.getByText("Turn it on to block ads and trackers")).toBeTruthy();
    expect(screen.queryByText("Clean so far")).toBeNull();
    expect(screen.getByAltText("Dive Privacy guardian").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByTestId("privacy-halo")).toBeTruthy();
    expect(screen.getByText("Ads blocked").parentElement?.nextSibling?.textContent).toBe("0");
    expect(screen.getByText("Trackers stopped").parentElement?.nextSibling?.textContent).toBe("0");
    expect(screen.getByText("YouTube protection").nextSibling?.textContent).toBe("Applies on youtube.com");
    // The toolbar button announces its popover rather than a pressed state.
    const trigger = screen.getByRole("button", { name: "Protection" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-pressed")).toBeNull();
    expect(screen.getByText("Rules 2026.09.04")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Protection on this site" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("switch", { name: "DivePrivacy protection" }).getAttribute("aria-checked")).toBe("false");
  });

  it("reports typed per-layer counts without treating generic network failures as privacy actions", () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    usePrivacy.setState({ byTab: { [tab.id]: { ads: 2, trackers: 1, youtube: 1 } } });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));

    expect(screen.getByText("Protected on this site")).toBeTruthy();
    expect(screen.getByText("4 privacy actions so far")).toBeTruthy();
    expect(screen.getByTestId("privacy-halo").className).toContain("privacy-halo");
    expect(screen.getByText("Ads blocked").parentElement?.nextSibling?.textContent).toBe("2");
    expect(screen.getByText("Trackers stopped").parentElement?.nextSibling?.textContent).toBe("1");
    expect(screen.getByLabelText("4 privacy actions on this page")).toBeTruthy();
  });

  it("does not present a working zero state when privacy events are unavailable", () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    usePrivacy.setState({ eventError: "privacy events unavailable" });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));

    expect(screen.getByText("Activity unavailable")).toBeTruthy();
    expect(screen.queryByText("Clean so far")).toBeNull();
  });

  it("persists an exact IP-host pause without duplicating the backend reload", async () => {
    useBrowser.setState({ tabs: [{ ...tab, url: "http://127.0.0.1:4173/fixture" }] });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    fireEvent.click(screen.getByRole("switch", { name: "Protection on this site" }));

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["127.0.0.1"] }));
    expect(ipc.prefsSet).toHaveBeenCalledTimes(1);
    expect(ipc.tabReload).not.toHaveBeenCalled();
    expect(screen.getByText("Protection paused here")).toBeTruthy();
    // Zero counts while paused are not a clean bill of health.
    expect(screen.getByText("Nothing is blocked while paused")).toBeTruthy();
    expect(screen.queryByText("Clean so far")).toBeNull();
  });

  it("removes only the active exact host when protection resumes", async () => {
    usePrefs.setState({
      prefs: { ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["other.example", "example.com"] },
      loaded: true,
    });

    render(<Toolbar />);
    // Paused here, so the trigger says so rather than just "Protection".
    fireEvent.click(screen.getByRole("button", { name: "Protection paused on this site" }));
    const site = screen.getByRole("switch", { name: "Protection on this site" });
    expect(site.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(site);

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["other.example"] }));
    expect(ipc.prefsSet).toHaveBeenCalledTimes(1);
    expect(ipc.tabReload).not.toHaveBeenCalled();
  });

  it("offers global enablement when DivePrivacy is off", async () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    fireEvent.click(screen.getByRole("switch", { name: "DivePrivacy protection" }));

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true }));
    expect(screen.queryByRole("switch", { name: "DivePrivacy protection" })).toBeNull();
    expect(screen.getByText("Protected on this site")).toBeTruthy();
  });

  it("moves focus to the stable site control after global protection is enabled", async () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    const global = screen.getByRole("switch", { name: "DivePrivacy protection" });
    global.focus();
    fireEvent.click(global);

    const site = screen.getByRole("switch", { name: "Protection on this site" });
    await waitFor(() => expect(document.activeElement).toBe(site));
    fireEvent.keyDown(site, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "All privacy settings" }));
  });

  it("shows and changes YouTube protection only on supported YouTube hosts", async () => {
    useBrowser.setState({ tabs: [{ ...tab, url: "https://www.youtube.com/watch?v=abc" }] });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    usePrivacy.setState({ byTab: { [tab.id]: { ads: 0, trackers: 0, youtube: 2 } } });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    expect(screen.getByText("YouTube protection").parentElement?.nextSibling?.textContent).toBe("Active");
    const youtube = screen.getByRole("switch", { name: "YouTube protection" });
    expect(youtube.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(youtube);

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true, youtube_protection: false }));
    expect(screen.getByText("YouTube protection").parentElement?.nextSibling?.textContent).toBe("Inactive");
  });

  it.each(["dive://screen", "not a valid URL"])("disables host-specific controls for %s", (url) => {
    useBrowser.setState({ tabs: [{ ...tab, url }] });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));

    expect((screen.getByRole("switch", { name: "Protection on this site" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Site controls unavailable")).toBeTruthy();
    expect(screen.getByText("Protection unavailable here")).toBeTruthy();
  });

  it("does not claim an absent active tab is protected", () => {
    useBrowser.setState({ tabs: [], activeTab: null });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));

    expect(screen.getByText("Protection unavailable here")).toBeTruthy();
    expect(screen.queryByText("Protected on this site")).toBeNull();
  });

  it("does not reload when preference persistence fails", async () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, block_trackers: true }, loaded: true });
    vi.mocked(ipc.prefsSet).mockRejectedValueOnce(new Error("disk full"));

    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    fireEvent.click(screen.getByRole("switch", { name: "Protection on this site" }));

    await waitFor(() => expect(useBrowser.getState().error).toBe("disk full"));
    expect(ipc.prefsSet).toHaveBeenCalledTimes(1);
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

  it("covers the native page only until an outside click closes the card", async () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Protection" }));
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("dialog", { name: "DivePrivacy protection" })).toBeNull();
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(false));
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

  it("keeps the page's own actions in the address field, even in compact chrome", () => {
    // Bookmark, share and protection act on the address they sit on, so they
    // stay in the pill at every width rather than hiding in a tray.
    render(<Toolbar compact />);

    const form = screen.getByRole("combobox", { name: "Address" }).closest("form");
    const field = screen.getByRole("combobox", { name: "Address" }).closest("[data-address-field]");
    for (const name of ["Bookmark this page", "Share to another device"]) {
      const button = screen.getByRole("button", { name });
      expect(field?.contains(button)).toBe(true);
      expect(form?.contains(button)).toBe(false);
    }
  });

  it("moves what is merely happening to the page into a tray in compact chrome", () => {
    render(<Toolbar compact />);

    fireEvent.click(screen.getByRole("button", { name: "More page actions" }));
    expect(screen.getByRole("dialog", { name: "Page actions" })).toBeTruthy();
  });
});
