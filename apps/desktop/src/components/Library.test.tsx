import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
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
  vi.spyOn(ipc, "historySearch").mockResolvedValue([
    { url: "https://a.test/", title: "A", last_visited_at: new Date().toISOString(), visits: 2, favicon: null },
    { url: "https://b.test/", title: "B", last_visited_at: new Date(Date.now() - 86_400_000).toISOString(), visits: 1, favicon: null },
  ]);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
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

    fireEvent.click(screen.getByRole("button", { name: "Clear browsing data…" }));
    expect(useBrowser.getState().open.settings).toBe(true);
    expect(useBrowser.getState().settingsSection).toBe("privacy");
  });

  it("closes on Escape and releases the page", async () => {
    render(<Library />);
    fireEvent.keyDown(screen.getByLabelText("Filter bookmarks"), { key: "Escape" });
    await waitFor(() => expect(useBrowser.getState().open.library).toBe(false));
  });
});
