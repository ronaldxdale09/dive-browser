import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useImportVideo } from "../screen/importVideo";
import { useBrowser } from "../store/browser";
import { screenUrl } from "./internal/InternalPage";
import { Library, dayLabel, groupByDay, matches } from "./Library";

const initial = useBrowser.getState();
// Local-time dates: day boundaries depend on the machine's zone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const now = new Date(2026, 8, 4, 12);

beforeEach(() => {
  useBrowser.setState({ ...initial, activeTab: "t1", activeWorkspace: "w1", open: { ...initial.open, library: true } }, true);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "tabNavigate").mockResolvedValue(null);
  vi.spyOn(ipc, "tabOpen").mockResolvedValue({ id: "t2", workspace_id: "w1", tier: "today", url: "https://docs.example.com/", title: "", favicon: null, position: 1, state: "active", last_active_at: "2026-09-04T00:00:00Z" });
  vi.spyOn(ipc, "bookmarkRemove").mockResolvedValue(true);
  vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([
    { url: "https://docs.example.com/", title: "Example docs", created_at: "2026-09-01T00:00:00Z", favicon: null },
    { url: "https://github.com/dive", title: "dive on GitHub", created_at: "2026-09-02T00:00:00Z", favicon: null },
  ]);
  vi.spyOn(ipc, "historyRemove").mockResolvedValue(true);
  vi.spyOn(ipc, "historySearch").mockResolvedValue([
    { url: "https://a.test/", title: "A", last_visited_at: new Date().toISOString(), visits: 2, favicon: null },
    { url: "https://b.test/", title: "B", last_visited_at: new Date(Date.now() - 86_400_000).toISOString(), visits: 1, favicon: null },
  ]);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
  useImportVideo.setState({ busy: false });
  vi.restoreAllMocks();
});

describe("Library helpers", () => {
  it("filters on title or URL, case-insensitively", () => {
    expect(matches("", "x", "y")).toBe(true);
    expect(matches("DOCS", "Example docs", "https://x")).toBe(true);
    expect(matches("github", "dive", "https://github.com/dive")).toBe(true);
    expect(matches("zzz", "dive", "https://github.com/dive")).toBe(false);
  });

  it("names days relative to now and groups rows in order", () => {
    expect(dayLabel(at(2026, 9, 4, 3), now)).toBe("Today");
    expect(dayLabel(at(2026, 9, 3, 23), now)).toBe("Yesterday");
    expect(dayLabel("nonsense", now)).toBe("Earlier");
    expect(dayLabel(at(2026, 8, 20), now)).not.toMatch(/Today|Yesterday/);
    const groups = groupByDay(
      [
        { url: "1", title: "", last_visited_at: at(2026, 9, 4, 3), visits: 1, favicon: null },
        { url: "2", title: "", last_visited_at: at(2026, 9, 4, 1), visits: 1, favicon: null },
        { url: "3", title: "", last_visited_at: at(2026, 9, 3, 1), visits: 1, favicon: null },
      ],
      now,
    );
    expect(groups.map((g) => [g.day, g.entries.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
  });
});

describe("Library dialog", () => {
  it("offers only files in a private window and opens on Downloads", () => {
    Object.defineProperty(window, "__DIVE_PRIVATE__", { value: true, configurable: true });
    try {
      useBrowser.getState().openLibrary("bookmarks");
      render(<Library />);
      expect(screen.queryByRole("tab", { name: "Bookmarks" })).toBeNull();
      expect(screen.queryByRole("tab", { name: "History" })).toBeNull();
      expect(screen.getByRole("tab", { name: "Downloads", selected: true })).toBeTruthy();
    } finally {
      Reflect.deleteProperty(window, "__DIVE_PRIVATE__");
    }
  });

  it("covers the page, lists bookmarks, filters them, and opens one in the current tab", async () => {
    render(<Library />);
    expect(screen.getByRole("dialog", { name: "Library" })).toBeTruthy();
    expect(contentCoverDepth()).toBe(1);
    expect(ipc.bookmarksSearch).toHaveBeenCalledWith("", 200);
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Filter bookmarks"), { target: { value: "github" } });
    expect(screen.queryByText("Example docs")).toBeNull();
    expect(screen.getByText("dive on GitHub")).toBeTruthy();

    fireEvent.click(screen.getByText("dive on GitHub"));
    await waitFor(() => expect(ipc.tabNavigate).toHaveBeenCalledWith("t1", "https://github.com/dive"));
    await waitFor(() => expect(useBrowser.getState().open.library).toBe(false));
  });

  it("shows a specific empty state for no bookmarks and another for a filter that matches nothing", async () => {
    vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([]);
    render(<Library />);
    await waitFor(() => expect(screen.getByText("No bookmarks yet")).toBeTruthy());
    expect(screen.getByText("Press ⌘D on a page to keep it here")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Downloads" }));
    expect(screen.getByText("Nothing downloaded yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.change(screen.getByLabelText("Filter history"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("Nothing matches")).toBeTruthy());
  });

  it("opens a bookmark in a new tab with the platform modifier and removes one", async () => {
    render(<Library />);
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());
    fireEvent.click(screen.getByText("Example docs"), { metaKey: true });
    await waitFor(() => expect(ipc.tabOpen).toHaveBeenCalledWith("w1", "https://docs.example.com/"));
    expect(ipc.tabNavigate).not.toHaveBeenCalled();
  });

  it("removes a bookmark from the list and the store", async () => {
    render(<Library />);
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark Example docs" }));
    expect(ipc.bookmarkRemove).toHaveBeenCalledWith("https://docs.example.com/");
    expect(screen.queryByText("Example docs")).toBeNull();
  });

  it("restores the bookmark and sets store error if removal rejects", async () => {
    vi.spyOn(ipc, "bookmarkRemove").mockRejectedValue(new Error("disk locked"));
    render(<Library />);
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove bookmark Example docs" }));
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());
    expect(useBrowser.getState().error).toBe("disk locked");
  });

  it("shows history grouped by day and hands clearing over to Settings", async () => {
    render(<Library />);
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(ipc.historySearch).toHaveBeenCalledWith("", 200);
    await waitFor(() => expect(screen.getByText("A")).toBeTruthy());
    expect(screen.getByRole("region", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Yesterday" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter history"), { target: { value: "b.test" } });
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.getByText("B")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter history"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove A from history" }));
    expect(ipc.historyRemove).toHaveBeenCalledWith("https://a.test/");
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.getByText("B")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear browsing data…" }));
    expect(useBrowser.getState().open.settings).toBe(true);
    expect(useBrowser.getState().settingsSection).toBe("privacy");
    expect(useBrowser.getState().settingsAnchor).toBe("clear-browsing-data");
  });

  it("closes on Escape and releases the page", async () => {
    render(<Library />);
    fireEvent.keyDown(screen.getByLabelText("Filter bookmarks"), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.library).toBe(false));
  });
});

describe("Library recordings import", () => {
  it("offers Open video even with no recordings, imports through the engine, and opens the editor tab", async () => {
    vi.spyOn(ipc, "recordingsList").mockResolvedValue([]);
    let finish!: (path: string) => void;
    vi.spyOn(ipc, "screenImportVideo").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<Library />);
    fireEvent.click(screen.getByRole("tab", { name: "Recordings" }));
    await waitFor(() => expect(screen.getByText(/No recordings yet/)).toBeTruthy());
    const button = screen.getByRole("button", { name: /Open video/ });
    fireEvent.click(button);
    expect(ipc.screenImportVideo).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: /Importing video/ })).toBeTruthy());
    expect(screen.getByText(/this can take a moment/)).toBeTruthy();
    finish("/captures/clip.mov");
    await waitFor(() => expect(ipc.tabOpen).toHaveBeenCalledWith("w1", screenUrl("/captures/clip.mov")));
    await waitFor(() => expect(useBrowser.getState().open.library).toBe(false));
  });

  it("lists imported containers with their own format and only offers editing when a companion exists", async () => {
    vi.spyOn(ipc, "recordingsList").mockResolvedValue([
      { path: "/captures/clip.mov", name: "clip.mov", format: "mov", bytes: 10, modified_ms: 1, editable: true, has_project: false },
      { path: "/captures/raw.mkv", name: "raw.mkv", format: "mkv", bytes: 10, modified_ms: 0, editable: false, has_project: false },
    ]);
    vi.spyOn(ipc, "screenImportVideo").mockRejectedValue(new Error("ffmpeg could not make a playable copy"));
    render(<Library />);
    fireEvent.click(screen.getByRole("tab", { name: "Recordings" }));
    await waitFor(() => expect(screen.getByText("clip.mov")).toBeTruthy());
    expect(screen.getByText(/MOV ·/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit clip.mov in DiveScreen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit raw.mkv in DiveScreen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open video/ }));
    await waitFor(() => expect(useBrowser.getState().error).toContain("ffmpeg could not make a playable copy"));
    expect(ipc.tabOpen).not.toHaveBeenCalled();
    expect(useBrowser.getState().open.library).toBe(true);
  });

  it("asks before deleting a recording, and removes it only on the second press", async () => {
    vi.spyOn(ipc, "recordingsList").mockResolvedValue([
      { path: "/captures/clip.mov", name: "clip.mov", format: "mov", bytes: 10, modified_ms: 1, editable: true, has_project: false },
    ]);
    const del = vi.spyOn(ipc, "recordingDelete").mockResolvedValue(null);
    render(<Library />);
    fireEvent.click(screen.getByRole("tab", { name: "Recordings" }));
    await waitFor(() => expect(screen.getByText("clip.mov")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete clip.mov" }));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this recording?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Delete this recording?")).toBeNull();
    expect(screen.getByText("clip.mov")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete clip.mov" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete clip.mov for good" }));
    expect(del).toHaveBeenCalledWith("/captures/clip.mov");
    await waitFor(() => expect(screen.queryByText("clip.mov")).toBeNull());
  });
});
