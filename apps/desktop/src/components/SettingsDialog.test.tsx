import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { useBrowser } from "../store/browser";
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
  useUpdates.setState({ status: "idle", update: null, error: null, installing: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsDialog", () => {
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
    fireEvent.click(screen.getByRole("switch", { name: "Block trackers" }));

    await waitFor(() => expect(ipc.prefsSet).toHaveBeenCalledWith({ ...DEFAULT_PREFS, block_trackers: true }));
    expect(usePrefs.getState().prefs.block_trackers).toBe(true);
  });

  it("only offers a search URL for a custom engine", () => {
    render(<SettingsDialog />);
    expect(screen.queryByLabelText("Search URL")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search engine"), { target: { value: "custom" } });
    expect(screen.getByLabelText("Search URL")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    useBrowser.setState({ open: { sidecar: false, dock: false, palette: false, find: false, settings: true, library: false, shortcuts: false } });
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
