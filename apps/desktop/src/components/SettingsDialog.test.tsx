import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { useBrowser } from "../store/browser";
import { useDefaultBrowser } from "../store/defaultBrowser";
import { usePrivacy } from "../store/privacy";
import { SettingsDialog, resolveSection, visibleSections } from "./SettingsDialog";
import { groupPermissions } from "./settings/Privacy";
import { useUpdates } from "../store/updates";

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "appInfo").mockResolvedValue({
    version: "0.1.0",
    build: { channel: "dev", number: "1", commit: "abc1234", built_at: 0 },
    data_dir: "/tmp/dive",
    mcp_url: "http://127.0.0.1:7391/mcp",
    mcp_token_path: "/tmp/dive/mcp-token",
    simulate: null,
  });
  vi.spyOn(ipc, "prefsGet").mockResolvedValue(DEFAULT_PREFS);
  vi.spyOn(ipc, "prefsSet").mockImplementation((prefs) => Promise.resolve(prefs));
  vi.spyOn(ipc, "commandsList").mockResolvedValue([
    { id: "tab.new", title: "New tab", keybinding: "mod+t", scope: "workspace" },
  ]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "permissionsList").mockResolvedValue({scope:{profile_id:"p1",container_id:"c1"},profile_name:"Personal",container_name:"Shared",legacy_ignored:true,permissions:[
    { origin: "https://meet.test", kind: "microphone", decision: "allow", scope:{profile_id:"p1",container_id:"c1"} },
    { origin: "https://meet.test", kind: "camera", decision: "allow", scope:{profile_id:"p1",container_id:"c1"} },
    { origin: "https://maps.test", kind: "geolocation", decision: "deny", scope:{profile_id:"p1",container_id:"c1"} },
  ]});
  vi.spyOn(ipc, "permissionSet").mockResolvedValue(null);
  vi.spyOn(ipc, "updateCheck").mockResolvedValue(null);
  vi.spyOn(ipc, "updateInstall").mockResolvedValue(null);
  useBrowser.setState({ settingsSection: "general" });
  usePrivacy.setState({ info: null });
  useUpdates.setState({ status: "idle", update: null, error: null, installing: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsDialog", () => {
  it("uses the complete DivePrivacy defaults fixture", () => {
    expect(DEFAULT_PREFS.youtube_protection).toBe(true);
    expect(DEFAULT_PREFS.privacy_exceptions).toEqual([]);
  });

  it("opens on General and moves between sections", async () => {
    render(<SettingsDialog />);
    expect(screen.getByLabelText("Search engine")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    expect(screen.getByRole("switch", { name: "Send Do Not Track" })).toBeTruthy();
    expect(screen.queryByLabelText("Search engine")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
    await waitFor(() => expect(screen.getByText("New tab")).toBeTruthy());
    expect(screen.getByText("⌘T")).toBeTruthy();
  });

  it("lands a Delete browsing data request on its group inside Privacy", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    useBrowser.getState().openSettings("privacy", "clear-browsing-data");
    render(<SettingsDialog />);
    expect(screen.getByRole("tab", { name: "Privacy", selected: true })).toBeTruthy();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect((scrolled.mock.instances[0] as HTMLElement).id).toBe("clear-browsing-data");
    expect(useBrowser.getState().settingsAnchor).toBeNull();
  });

  it("keeps the download folder under General and lands a downloads request there", () => {
    expect(resolveSection("downloads")).toBe("general");
    expect(resolveSection("about")).toBe("about");
    useBrowser.getState().openSettings("downloads");
    render(<SettingsDialog />);
    expect(screen.getByRole("tab", { name: "General", selected: true })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Downloads" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Downloads" })).toBeTruthy();
    expect(screen.getByLabelText("Save files to")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Search" }).compareDocumentPosition(screen.getByRole("heading", { name: "Downloads" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("mentions permissions from earlier versions only when some were set aside", async () => {
    useBrowser.getState().openSettings("privacy");
    const { unmount } = render(<SettingsDialog />);
    expect(await screen.findByText(/Permissions from earlier versions/)).toBeTruthy();
    unmount();
    vi.spyOn(ipc, "permissionsList").mockResolvedValue({ scope: { profile_id: "p1", container_id: "c1" }, profile_name: "Personal", container_name: "Shared", legacy_ignored: false, permissions: [{ scope: { profile_id: "p1", container_id: "c1" }, origin: "https://a.dev", kind: "geolocation", decision: "allow" }] as never });
    render(<SettingsDialog />);
    expect(await screen.findByText("https://a.dev")).toBeTruthy();
    expect(screen.queryByText(/Permissions from earlier versions/)).toBeNull();
  });

  it("persists a toggled preference", async () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    fireEvent.click(screen.getByRole("switch", { name: "DivePrivacy protection" }));

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true }));
    expect(usePrefs.getState().prefs.block_trackers).toBe(true);
  });

  it("separates bundled DivePrivacy controls from advanced custom URL rules", () => {
    const prefs = {
      ...DEFAULT_PREFS,
      block_trackers: true,
      blocked_patterns: ["ads.example.test"],
      privacy_exceptions: ["example.com"],
    };
    usePrefs.setState({ prefs, loaded: true });
    vi.mocked(ipc.prefsGet).mockResolvedValue(prefs);
    usePrivacy.setState({ info: { version: "2026.09.04.1", ad_rules: 63, tracker_rules: 62, cosmetic_hosts: 4 } });

    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));

    expect(screen.getByRole("switch", { name: "DivePrivacy protection" })).toBeTruthy();
    const youtube = screen.getByRole("switch", { name: "YouTube protection" }) as HTMLButtonElement;
    expect(youtube.disabled).toBe(false);
    expect(youtube.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Rules ship inside the signed app and work offline/)).toBeTruthy();
    expect(screen.getByText("2026.09.04.1")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Advanced" })).toBeTruthy();
    expect((screen.getByLabelText("Custom URL rules") as HTMLTextAreaElement).value).toBe("ads.example.test");
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.queryByText("Block trackers")).toBeNull();
    expect(screen.queryByLabelText("Blocked hosts")).toBeNull();
  });

  it("disables YouTube protection while DivePrivacy is off", () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));

    expect((screen.getByRole("switch", { name: "YouTube protection" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes an exact-host exception", async () => {
    const prefs = { ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["other.test", "example.com"] };
    usePrefs.setState({ prefs, loaded: true });
    vi.mocked(ipc.prefsGet).mockResolvedValue(prefs);
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));

    fireEvent.click(screen.getByRole("button", { name: "Resume protection on example.com" }));

    expect(screen.queryByText("example.com")).toBeNull();
    await waitFor(() =>
      expect(ipc.prefsSet).toHaveBeenCalledWith({ ...prefs, privacy_exceptions: ["other.test"] }),
    );
  });

  it("restores an exception when removing it fails to persist", async () => {
    const prefs = { ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["example.com"] };
    usePrefs.setState({ prefs, loaded: true });
    vi.mocked(ipc.prefsGet).mockResolvedValue(prefs);
    vi.mocked(ipc.prefsSet).mockRejectedValue(new Error("preferences unavailable"));
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));

    fireEvent.click(screen.getByRole("button", { name: "Resume protection on example.com" }));

    await waitFor(() => expect(screen.getByText("example.com")).toBeTruthy());
    expect(useBrowser.getState().error).toBe("preferences unavailable");
  });

  it("does not let its initial preferences load restore a removed exception", async () => {
    const prefs = { ...DEFAULT_PREFS, block_trackers: true, privacy_exceptions: ["example.com"] };
    let finishLoad!: (value: typeof prefs) => void;
    usePrefs.setState({ prefs, loaded: false });
    vi.mocked(ipc.prefsGet).mockImplementation(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));

    fireEvent.click(screen.getByRole("button", { name: "Resume protection on example.com" }));
    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...prefs, privacy_exceptions: [] }));
    finishLoad(prefs);

    await waitFor(() => expect(usePrefs.getState().loaded).toBe(true));
    expect(usePrefs.getState().prefs.privacy_exceptions).toEqual([]);
  });

  it("offers the default-browser flow from General while Dive is not the default", () => {
    useDefaultBrowser.setState({ status: { supported: true, is_default: false, current: "com.brave.Browser" } });
    render(<SettingsDialog />);
    expect(screen.getByText("They open in Brave.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make default…" }));
    expect(useBrowser.getState().open.defaultBrowser).toBe(true);
    useDefaultBrowser.setState({ status: { supported: true, is_default: true, current: "com.dive.browser" } });
  });

  it("only offers a search URL for a custom engine, and warns when it has no {query}", async () => {
    render(<SettingsDialog />);
    expect(screen.queryByLabelText("Search URL")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search engine"), { target: { value: "custom" } });
    const url = screen.getByLabelText("Search URL");
    fireEvent.change(url, { target: { value: "https://kagi.com/search?q=" } });
    fireEvent.blur(url);
    await waitFor(() => expect(screen.getByText(/Put \{query\} where the search words go/)).toBeTruthy());
    // The field remounts on every saved value, so find it again.
    const again = screen.getByLabelText("Search URL");
    fireEvent.change(again, { target: { value: "https://kagi.com/search?q={query}" } });
    fireEvent.blur(again);
    await waitFor(() => expect(screen.queryByText(/Put \{query\} where/)).toBeNull());
  });

  it("closes on Escape", async () => {
    useBrowser.setState({ open: { sidecar: false, dock: false, palette: false, find: false, settings: true, library: false, shortcuts: false, menu: false, defaultBrowser: false, subtitles: false } });
    render(<SettingsDialog />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.settings).toBe(false));
  });
});

describe("Site permissions", () => {
  it("groups decisions by origin, kinds sorted", () => {
    const groups = groupPermissions([
      { origin: "https://b.test", kind: "camera", decision: "allow", scope:{profile_id:"p1",container_id:"c1"} },
      { origin: "https://a.test", kind: "microphone", decision: "deny", scope:{profile_id:"p1",container_id:"c1"} },
      { origin: "https://a.test", kind: "camera", decision: "allow", scope:{profile_id:"p1",container_id:"c1"} },
    ]);
    expect(groups.map((g) => [g.origin, g.kinds.map((k) => k.kind)])).toEqual([
      ["https://a.test", ["camera", "microphone"]],
      ["https://b.test", ["camera"]],
    ]);
  });

  it("lists remembered decisions and writes a change", async () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    await waitFor(() => expect(screen.getByText("https://meet.test")).toBeTruthy());
    const select = screen.getByLabelText("https://maps.test Location") as HTMLSelectElement;
    expect(select.value).toBe("deny");
    fireEvent.change(select, { target: { value: "allow" } });
    expect(ipc.permissionSet).toHaveBeenCalledWith({profile_id:"p1",container_id:"c1"}, "https://maps.test", "geolocation", "allow");
    expect((screen.getByLabelText("https://maps.test Location") as HTMLSelectElement).value).toBe("allow");
  });

  it("forgetting a decision sets it back to ask and drops the row", async () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    await waitFor(() => expect(screen.getByText("https://maps.test")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Forget https://maps.test Location" }));
    expect(ipc.permissionSet).toHaveBeenCalledWith({profile_id:"p1",container_id:"c1"}, "https://maps.test", "geolocation", "ask");
    expect(screen.queryByText("https://maps.test")).toBeNull();
    expect(screen.getByText("https://meet.test")).toBeTruthy();
  });

  it("shows a failed permission read instead of claiming the list is empty", async () => {
    vi.mocked(ipc.permissionsList).mockRejectedValue(new Error("permission store unavailable"));
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("permission store unavailable"));
    expect(screen.queryByText("No site has asked for anything yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry site permissions" })).toBeTruthy();
  });

  it("rolls a permission decision back when persistence fails", async () => {
    vi.mocked(ipc.permissionSet).mockRejectedValue(new Error("permission write failed"));
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    await waitFor(() => expect(screen.getByText("https://maps.test")).toBeTruthy());

    const select = screen.getByLabelText("https://maps.test Location") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "allow" } });

    await waitFor(() => expect(select.value).toBe("deny"));
    expect(screen.getByRole("alert").textContent).toContain("permission write failed");
  });

  it("disables a permission decision while its write is pending", async () => {
    let finish!: () => void;
    vi.mocked(ipc.permissionSet).mockImplementation(() => new Promise<null>((resolve) => {
      finish = () => resolve(null);
    }));
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    await waitFor(() => expect(screen.getByText("https://maps.test")).toBeTruthy());

    const select = screen.getByLabelText("https://maps.test Location") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "allow" } });
    expect(select.disabled).toBe(true);

    finish();
    await waitFor(() => expect(select.disabled).toBe(false));
  });
});

describe("private window", () => {
  it("lists only the sections private mode can use, and no import", async () => {
    expect(visibleSections(true).map((s) => s.id)).toEqual(["general", "appearance", "privacy", "developer", "shortcuts", "about"]);
    expect(visibleSections(false)).toHaveLength(8);
    (window as Window & { __DIVE_PRIVATE__?: boolean }).__DIVE_PRIVATE__ = true;
    try {
      render(<SettingsDialog />);
      expect(screen.queryByRole("tab", { name: "Agent" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "Live subtitles" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Import" })).toBeNull();
    } finally {
      delete (window as Window & { __DIVE_PRIVATE__?: boolean }).__DIVE_PRIVATE__;
    }
  });
});

describe("About and updates", () => {
  it("opens on the panel openSettings asked for and shows build facts with a copyable MCP URL", async () => {
    useBrowser.getState().openSettings("about");
    render(<SettingsDialog />);
    expect(screen.getByRole("tab", { name: "About", selected: true })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("/tmp/dive")).toBeTruthy());
    expect(screen.getByText("http://127.0.0.1:7391/mcp")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy MCP URL" })).toBeTruthy();
  });

  it("reports being up to date when the release channel has nothing", async () => {
    vi.mocked(ipc.appInfo).mockResolvedValue({
      version: "0.1.0",
      build: { channel: "beta", number: "1", commit: "abc1234", built_at: 0 },
      data_dir: "/tmp/dive",
      mcp_url: "http://127.0.0.1:7391/mcp",
      mcp_token_path: "/tmp/dive/mcp-token",
      simulate: null,
    });
    useBrowser.getState().openSettings("about");
    render(<SettingsDialog />);
    await waitFor(() => expect(screen.getByText("/tmp/dive")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("You're up to date"));
    expect(screen.getByText("You're up to date.")).toBeTruthy();
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.queryByText("Updates are delivered to release builds.")).toBeNull();
  });

  it("offers to reset Dive back to the intro after a confirmation", async () => {
    const { useOnboarding } = await import("../store/onboarding");
    useOnboarding.setState({ stage: null });
    useBrowser.getState().openSettings("about");
    render(<SettingsDialog />);
    await waitFor(() => expect(screen.getByText("/tmp/dive")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reset Dive…" }));
    expect(useOnboarding.getState().stage).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Reset and replay/ }));
    await waitFor(() => expect(useOnboarding.getState().stage).toBe("intro"));
    expect(usePrefs.getState().prefs.onboarded).toBe(false);
    expect(useBrowser.getState().open.settings).toBe(false);
  });

  it("tells a dev build where updates go and offers no check that would find nothing", async () => {
    useBrowser.getState().openSettings("about");
    render(<SettingsDialog />);
    await waitFor(() => expect(screen.getByText("Updates are delivered to release builds.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Check for updates|Check again/ })).toBeNull();
    expect(screen.queryByText(/You're up to date/)).toBeNull();
  });

  it("shows the MCP command with a short token path but copies the full one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useBrowser.getState().openSettings("developer");
    render(<SettingsDialog />);
    const shown = await screen.findByText(/claude mcp add/);
    expect(shown.textContent).toContain("…/mcp-token");
    expect(shown.textContent).not.toContain("/tmp/dive/mcp-token");
    expect(shown.getAttribute("title")).toContain("/tmp/dive/mcp-token");
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("$(cat '/tmp/dive/mcp-token')"));
    // Copying is announced, not only shown as a changed icon.
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(screen.getByRole("status").textContent).toBe("Copied to the clipboard");
  });

  it("offers to install an update it finds", async () => {
    vi.mocked(ipc.updateCheck).mockResolvedValue({ version: "0.2.0", notes: "Faster tabs." });
    useBrowser.getState().openSettings("about");
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByText("Dive 0.2.0 is available")).toBeTruthy());
    expect(screen.getByText("Faster tabs.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    await waitFor(() => expect(ipc.updateInstall).toHaveBeenCalledTimes(1));
  });
});
