import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { useBrowser } from "../store/browser";
import { SettingsDialog } from "./SettingsDialog";

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
    useBrowser.setState({ open: { sidecar: false, dock: false, palette: false, find: false, settings: true } });
    render(<SettingsDialog />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.settings).toBe(false));
  });
});
