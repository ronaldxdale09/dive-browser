import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { ipc } from "../../lib/ipc";
import { General, restoreNotice, zoomOptions } from "./General";
import { useBrowser } from "../../store/browser";

const initialPrefs = usePrefs.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "backupExport").mockResolvedValue(null);
  vi.spyOn(ipc, "backupRestore").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("Settings › General", () => {
  it("does not say Safari bookmarks can be read on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/from Safari/);
    expect(document.body.textContent).toMatch(/AppData/);
  });

  it("does not say a backup leaves passwords only in the Keychain on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/Keychain/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });

  it("does not say the default download folder is ~/Downloads on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/~\//);
    expect(screen.getByLabelText("Save files to").getAttribute("placeholder")).not.toBe("~/Downloads");
    expect(document.body.textContent).toMatch(/Downloads folder/);
  });

  it("does not name ⌘ chords for zoom and fill-tab on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/⌘/);
    expect(document.body.textContent).toMatch(/Ctrl\+=/);
    expect(document.body.textContent).toMatch(/Ctrl\+Shift\+F/);
  });

  it("restores preferences only when asked to, and reads them back", async () => {
    const restore = vi.spyOn(ipc, "backupRestore").mockResolvedValue({ bookmarks: 2, history: 0, form_entries: 0, workspaces: 0, tabs: 0, preferences: true });
    const get = vi.spyOn(ipc, "prefsGet").mockResolvedValue({ ...DEFAULT_PREFS, homepage: "https://restored.test" });
    render(<General />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include preferences" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore…" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(true));
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(useBrowser.getState().notice).toBe("Restored 2 bookmarks. Preferences were restored too."));
  });

  it("counts only what a restore added", () => {
    expect(restoreNotice({ bookmarks: 1, history: 3, form_entries: 0, workspaces: 0, tabs: 0, preferences: false })).toBe("Restored 1 bookmark, 3 visits of history.");
    expect(restoreNotice({ bookmarks: 0, history: 0, form_entries: 0, workspaces: 0, tabs: 0, preferences: false })).toMatch(/nothing this profile did not have/);
  });

  it("picks a download folder through the host and shows why one was refused", async () => {
    vi.spyOn(ipc, "downloadDirPick").mockResolvedValue("/Volumes/Shared");
    vi.spyOn(ipc, "prefsSet").mockRejectedValue(new Error("Dive cannot save files in /Volumes/Shared: read-only"));
    render(<General />);
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    expect(await screen.findByText(/cannot save files in \/Volumes\/Shared/)).toBeTruthy();
    expect(usePrefs.getState().prefs.download_dir).toBe("");
  });

  it("shows a zoom that is not a listed step as itself", () => {
    expect(zoomOptions(100).some((o) => o.label.startsWith("Custom"))).toBe(false);
    const options = zoomOptions(80);
    expect(options.find((o) => o.value === "80")?.label).toBe("Custom (80%)");
    expect(options.map((o) => Number(o.value))).toEqual([...options.map((o) => Number(o.value))].sort((a, b) => a - b));
  });
});
