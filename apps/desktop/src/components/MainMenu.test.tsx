import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { MainMenu } from "./MainMenu";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFullscreen: () => Promise.resolve(false), setFullscreen: () => Promise.resolve() }) }));

const tab: Tab = { id: "t1", workspace_id: "w", tier: "today", url: "https://example.com", title: "Example", favicon: null, position: 0, state: "active", last_active_at: "2026-09-04T00:00:00Z" };

beforeEach(() => {
  useBrowser.setState({
    tabs: [tab],
    activeTab: tab.id,
    activeWorkspace: "w",
    detached: [],
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, shortcuts: false, menu: true, defaultBrowser: false, subtitles: false, tasks: false },
  });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "recordingsList").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MainMenu", () => {
  it("lists recently closed tabs, newest first, and reopens the one chosen", () => {
    const reopen = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({
      reopenClosedTab: reopen,
      closedTabs: [
        { url: "https://old.test/", title: "Old", workspace_id: "w", index: 0 },
        { url: "https://new.test/", title: "New", workspace_id: "w", index: 1 },
      ],
    });
    render(<MainMenu />);
    const group = screen.getByRole("group", { name: "Recently closed" });
    const rows = Array.from(group.querySelectorAll('[role="menuitem"]')).map((row) => row.textContent);
    expect(rows).toEqual(["New", "Old"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Old" }));
    expect(reopen).toHaveBeenCalledWith(0);
    useBrowser.setState({ closedTabs: [] });
  });

  it("drops what a private window cannot do and leads with the way out", () => {
    Object.defineProperty(window, "__DIVE_PRIVATE__", { value: true, configurable: true });
    try {
      render(<MainMenu />);
      const labels = screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
      expect(labels[0]).toContain("Exit private mode");
      expect(labels.some((l) => l.startsWith("Live subtitles"))).toBe(false);
      expect(labels.some((l) => l.startsWith("Agent"))).toBe(false);
      expect(labels.some((l) => l.startsWith("New workspace"))).toBe(false);
      expect(labels.some((l) => l.startsWith("Bookmarks"))).toBe(false);
      expect(labels.some((l) => l.startsWith("History"))).toBe(false);
      expect(labels.some((l) => l.startsWith("Downloads"))).toBe(true);
      expect(labels.some((l) => l.startsWith("Apps"))).toBe(true);
    } finally {
      Reflect.deleteProperty(window, "__DIVE_PRIVATE__");
    }
  });

  it("does not show a detached tab's zoom as this window's", () => {
    useBrowser.setState({ tabs: [tab], activeTab: tab.id, detached: [tab.id], zoom: { [tab.id]: 1.5 }, defaultZoom: 1 });
    expect(tabInThisWindow(useBrowser.getState().activeTab, useBrowser.getState().detached)).toBeNull();
    render(<MainMenu />);
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("100%");
    expect((screen.getByRole("button", { name: "Reset zoom" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not offer page actions for a detached tab as this window's", () => {
    useBrowser.setState({ tabs: [tab], activeTab: tab.id, detached: [tab.id] });
    expect(tabInThisWindow(useBrowser.getState().activeTab, useBrowser.getState().detached)).toBeNull();
    render(<MainMenu />);
    expect((screen.getByRole("menuitem", { name: /Print/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: /Picture in Picture/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: /Find in page/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: /Copy bug report/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: /Bring tab back/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lists the browser's pages and features with their shortcuts", () => {
    render(<MainMenu />);
    for (const name of ["New tab", "Bookmarks", "History", "Downloads", "Recordings", "Settings", "Apps", "Print…"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(name.replace("…", "")) })).toBeTruthy();
    }
    // The tools are in Apps, not listed here a second time.
    for (const tool of ["Device simulator", "Record a video", "Live subtitles", "Developer dock", "DevTools"]) expect(screen.queryByRole("menuitem", { name: new RegExp(tool) })).toBeNull();
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

  it("offers the import dialog from the library group", () => {
    render(<MainMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Import from another browser/ }));
    expect(useBrowser.getState().open.import).toBe(true);
  });

  it("opens settings sections and closes itself", () => {
    render(<MainMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear browsing data/ }));
    expect(useBrowser.getState().open.settings).toBe(true);
    expect(useBrowser.getState().settingsSection).toBe("privacy");
  });

  it("synchronizes keyboard selection with rendered menu items past the zoom row", async () => {
    const pipSpy = vi.spyOn(ipc, "tabPictureInPicture").mockResolvedValue(null as never);
    render(<MainMenu />);
    const menuItems = screen.getAllByRole("menuitem");
    const pipItem = screen.getByRole("menuitem", { name: /Picture in Picture/ });
    const pipIndex = menuItems.indexOf(pipItem);
    expect(pipIndex).toBeGreaterThan(0);

    // Hovering on Picture in Picture sets the cursor to it
    fireEvent.mouseEnter(pipItem);

    // Enter executes the selected item
    const search = screen.getByRole("textbox", { name: "Search the menu" });
    fireEvent.keyDown(search, { key: "Enter" });
    // Menu closes and command runs
    await waitFor(() => expect(useBrowser.getState().open.menu).toBe(false));
    expect(pipSpy).toHaveBeenCalledWith("t1");
  });

  it("keeps Print findable but disabled, saying why, since this engine cannot print", () => {
    render(<MainMenu />);
    const print = screen.getByRole("menuitem", { name: /Print/ }) as HTMLButtonElement;
    expect(print.disabled).toBe(true);
    expect(print.textContent).toContain("Not available yet");
    expect(print.getAttribute("title")).toBe("Not available yet");
  });
});
