import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { useBrowser } from "../store/browser";
import { usePrivacy } from "../store/privacy";
import { SettingsDialog, groupPermissions } from "./SettingsDialog";
import { useUpdates } from "../store/updates";

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "appInfo").mockResolvedValue({
    version: "0.1.0",
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
  vi.spyOn(ipc, "permissionsList").mockResolvedValue([
    { origin: "https://meet.test", kind: "microphone", decision: "allow" },
    { origin: "https://meet.test", kind: "camera", decision: "allow" },
    { origin: "https://maps.test", kind: "geolocation", decision: "deny" },
  ]);
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

  it("only offers a search URL for a custom engine", () => {
    render(<SettingsDialog />);
    expect(screen.queryByLabelText("Search URL")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search engine"), { target: { value: "custom" } });
    expect(screen.getByLabelText("Search URL")).toBeTruthy();
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
      { origin: "https://b.test", kind: "camera", decision: "allow" },
      { origin: "https://a.test", kind: "microphone", decision: "deny" },
      { origin: "https://a.test", kind: "camera", decision: "allow" },
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
    expect(ipc.permissionSet).toHaveBeenCalledWith("https://maps.test", "geolocation", "allow");
    expect((screen.getByLabelText("https://maps.test Location") as HTMLSelectElement).value).toBe("allow");
  });

  it("forgetting a decision sets it back to ask and drops the row", async () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    await waitFor(() => expect(screen.getByText("https://maps.test")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Forget https://maps.test Location" }));
    expect(ipc.permissionSet).toHaveBeenCalledWith("https://maps.test", "geolocation", "ask");
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

describe("About and updates", () => {
  it("opens on the panel openSettings asked for and shows build facts with a copyable MCP URL", async () => {
    useBrowser.getState().openSettings("about");
    render(<SettingsDialog />);
    expect(screen.getByRole("tab", { name: "About", selected: true })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("/tmp/dive")).toBeTruthy());
    expect(screen.getByText("http://127.0.0.1:7391/mcp")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy MCP URL" })).toBeTruthy();
  });

  it("reports being up to date when the channel has nothing", async () => {
    useBrowser.getState().openSettings("about");
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("You're up to date"));
    expect(ipc.updateCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
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
