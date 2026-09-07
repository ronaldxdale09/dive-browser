import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { MainMenu } from "./MainMenu";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFullscreen: () => Promise.resolve(false), setFullscreen: () => Promise.resolve() }) }));

const tab: Tab = { id: "t1", workspace_id: "w", tier: "today", url: "https://example.com", title: "Example", favicon: null, position: 0, state: "active", last_active_at: "2026-09-04T00:00:00Z" };

beforeEach(() => {
  useBrowser.setState({
    tabs: [tab],
    activeTab: tab.id,
    activeWorkspace: "w",
    detached: [],
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, shortcuts: false, menu: true, defaultBrowser: false, subtitles: false },
  });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "recordingsList").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MainMenu", () => {
  it("lists the browser's pages and features with their shortcuts", () => {
    render(<MainMenu />);
    for (const name of ["New tab", "Bookmarks", "History", "Downloads", "Recordings", "Settings", "Device simulator", "Record a video", "Live subtitles", "Print…"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(name.replace("…", "")) })).toBeTruthy();
    }
    expect(screen.getByText("⌘T")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
  });

  it("filters as you type and runs the first match on Enter", () => {
    render(<MainMenu />);
    const search = screen.getByRole("textbox", { name: "Search the menu" });
    fireEvent.change(search, { target: { value: "histo" } });
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    const { open, libraryTab } = useBrowser.getState();
    expect(libraryTab).toBe("history");
    expect(open.library).toBe(true);
    expect(open.menu).toBe(false);
  });

  it("opens settings sections and closes itself", () => {
    render(<MainMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete browsing data/ }));
    expect(useBrowser.getState().open.settings).toBe(true);
    expect(useBrowser.getState().settingsSection).toBe("privacy");
  });
});
