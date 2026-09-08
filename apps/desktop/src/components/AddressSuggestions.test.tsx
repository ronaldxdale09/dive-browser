import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { events, ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { Toolbar } from "./Toolbar";

const tab: Tab = {
  id: "tab-1",
  workspace_id: "workspace-1",
  tier: "today",
  url: "https://example.com/docs",
  title: "Example",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-06T00:00:00Z",
};
const other: Tab = { ...tab, id: "tab-2", url: "https://rust-lang.org/learn", title: "Learn Rust", position: 1 };

beforeEach(() => {
  useBrowser.setState({ tabs: [tab, other], activeTab: tab.id, activeWorkspace: tab.workspace_id, error: null, loading: {}, zoom: {} });
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "bookmarkStatus").mockResolvedValue(false);
  vi.spyOn(ipc, "tabHistory").mockResolvedValue({ generation: "g", current_index: 0, entries: [{ id: 1, title: "Example", url: tab.url }] });
  vi.spyOn(events.tabHistoryChanged, "listen").mockResolvedValue(() => {});
  vi.spyOn(ipc, "tabNavigate").mockResolvedValue(null);
  vi.spyOn(ipc, "tabActivate").mockResolvedValue(null);
  vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([{ url: "https://doc.rust-lang.org/book/", title: "The Rust Book", created_at: "2026-09-06T00:00:00Z", favicon: null }]);
  vi.spyOn(ipc, "historySearch").mockResolvedValue([
    { url: "https://rust-lang.org/learn", title: "Learn Rust", last_visited_at: "2026-09-06T00:00:00Z", visits: 3, favicon: null },
    { url: "https://crates.io/search?q=rust", title: "crates.io", last_visited_at: "2026-09-06T00:00:00Z", visits: 1, favicon: null },
  ]);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  vi.restoreAllMocks();
});

function address() {
  return screen.getByRole("combobox", { name: "Address" }) as HTMLInputElement;
}

describe("address bar suggestions", () => {
  it("shows nothing until there is a draft, then the literal row, tabs, bookmarks and history", async () => {
    render(<Toolbar />);
    const input = address();
    act(() => input.focus());
    // Focusing selects the current address; that alone asks nothing.
    expect(input.value).toBe(tab.url);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(input, { target: { value: "rust" } });
    const list = screen.getByRole("listbox", { name: "Address suggestions" });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const rows = () => Array.from(list.querySelectorAll("[role='option']")).map((row) => row.textContent);
    expect(rows()[0]).toContain("Search");
    expect(rows()[1]).toContain("Learn Rust");
    expect(rows()[1]).toContain("Switch to tab");
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(rows()[2]).toContain("The Rust Book");
    expect(rows()[3]).toContain("crates.io");
    expect(list.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).toBe(list.querySelector("[role='option']")!.id);
  });

  it("says Open for an address and navigates it on Enter", async () => {
    render(<Toolbar />);
    const input = address();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "docs.rs" } });
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("Open");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(ipc.tabNavigate).toHaveBeenCalledWith(tab.id, "docs.rs"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("switches to the matched tab with ArrowDown then Enter", async () => {
    render(<Toolbar />);
    const input = address();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "learn" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const rows = screen.getAllByRole("option");
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(rows[1]!.id);
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(ipc.tabActivate).toHaveBeenCalledWith(other.id));
    expect(ipc.tabNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens a row on click without having taken focus from the input", async () => {
    render(<Toolbar />);
    const input = address();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "rust" } });
    const row = await screen.findByRole("option", { name: /The Rust Book/ });
    const down = fireEvent.mouseDown(row);
    expect(down).toBe(false);
    expect(document.activeElement).toBe(input);
    fireEvent.click(row);
    await waitFor(() => expect(ipc.tabNavigate).toHaveBeenCalledWith(tab.id, "https://doc.rust-lang.org/book/"));
  });

  it("closes on Escape and restores the current address", () => {
    render(<Toolbar />);
    const input = address();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "learn" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("example.com/docs");
    expect(document.activeElement).not.toBe(input);
  });

  it("closes when the input loses focus", () => {
    render(<Toolbar />);
    const input = address();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "learn" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.blur(input);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("hides the page only while the list is on screen", async () => {
    render(<Toolbar />);
    const input = address();
    expect(contentCoverDepth()).toBe(0);
    act(() => input.focus());
    expect(contentCoverDepth()).toBe(0);
    fireEvent.change(input, { target: { value: "learn" } });
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false));
  });

  it("asks the store once per pause in typing", async () => {
    vi.useFakeTimers();
    try {
      render(<Toolbar />);
      const input = address();
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "r" } });
      fireEvent.change(input, { target: { value: "ru" } });
      fireEvent.change(input, { target: { value: "rus" } });
      act(() => void vi.advanceTimersByTime(119));
      expect(ipc.historySearch).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(2));
      expect(ipc.historySearch).toHaveBeenCalledTimes(1);
      expect(ipc.historySearch).toHaveBeenCalledWith("rus", 8);
      expect(ipc.bookmarksSearch).toHaveBeenCalledWith("rus", 8);
    } finally {
      vi.useRealTimers();
    }
  });
});
