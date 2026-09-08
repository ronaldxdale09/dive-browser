import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { BookmarkButton } from "./BookmarkButton";
import { BOOKMARKS_CHANGED } from "../lib/commands";

const tab: Tab = {
  id: "tab-1",
  workspace_id: "workspace-1",
  tier: "today",
  url: "https://example.com/docs",
  title: "Example docs",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-06T00:00:00Z",
};

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, error: null, notice: null });
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "bookmarkStatus").mockResolvedValue(false);
  vi.spyOn(ipc, "bookmarkToggle").mockResolvedValue(true);
  vi.spyOn(ipc, "bookmarkRemove").mockResolvedValue(true);
  vi.spyOn(ipc, "bookmarkRename").mockResolvedValue(null);
  vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  vi.restoreAllMocks();
});

async function openPopover() {
  render(<BookmarkButton />);
  const star = screen.getByRole("button", { name: "Bookmark this page" });
  act(() => star.focus());
  fireEvent.click(star);
  return screen.findByRole("dialog", { name: "Bookmark added" });
}

describe("BookmarkButton", () => {
  it("saves a new page and opens the popover with its title and host", async () => {
    const dialog = await openPopover();
    expect(ipc.bookmarkToggle).toHaveBeenCalledWith(tab.id);
    const title = screen.getByRole("textbox", { name: "Bookmark title" }) as HTMLInputElement;
    expect(title.value).toBe("Example docs");
    // Focus moves in an effect after the popover commits, so it can land a tick later.
    await waitFor(() => expect(document.activeElement).toBe(title));
    // The whole title is selected, so typing a new name replaces it.
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, title.value.length]);
    expect(dialog.textContent).toContain("example.com");
    expect(screen.getByRole("button", { name: "Edit bookmark" }).getAttribute("aria-pressed")).toBe("true");
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));
    expect(useBrowser.getState().notice).toBeNull();
  });

  it("opens an existing bookmark as Edit bookmark with the name it was saved under", async () => {
    vi.mocked(ipc.bookmarkStatus).mockResolvedValue(true);
    vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([{ url: tab.url, title: "My docs", created_at: "2026-09-06T00:00:00Z", favicon: null }]);
    render(<BookmarkButton />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit bookmark" }));
    await screen.findByRole("dialog", { name: "Edit bookmark" });
    const title = screen.getByRole("textbox", { name: "Bookmark title" }) as HTMLInputElement;
    expect(title.value).toBe("My docs");
    expect(ipc.bookmarkToggle).not.toHaveBeenCalled();
    // The saved name unchanged: nothing to rename.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(ipc.bookmarkRename).not.toHaveBeenCalled();
  });

  it("saves an edited title through Done", async () => {
    await openPopover();
    const title = screen.getByRole("textbox", { name: "Bookmark title" });
    fireEvent.change(title, { target: { value: "Docs I keep coming back to" } });
    vi.mocked(ipc.bookmarkToggle).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(ipc.bookmarkRename).toHaveBeenCalledWith(tab.url, "Docs I keep coming back to"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
  });

  it("saves an edited title with Enter and leaves an unchanged title alone", async () => {
    await openPopover();
    const title = screen.getByRole("textbox", { name: "Bookmark title" });
    fireEvent.submit(title.closest("form")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ipc.bookmarkRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit bookmark" }));
    expect(ipc.bookmarkToggle).toHaveBeenCalledTimes(1);
    const again = await screen.findByRole("textbox", { name: "Bookmark title" });
    fireEvent.change(again, { target: { value: "Renamed" } });
    fireEvent.submit(again.closest("form")!);
    await waitFor(() => expect(ipc.bookmarkRename).toHaveBeenCalledWith(tab.url, "Renamed"));
    expect(ipc.bookmarkRemove).not.toHaveBeenCalled();
  });

  it("removes the bookmark, closes and confirms with a toast", async () => {
    await openPopover();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(ipc.bookmarkRemove).toHaveBeenCalledWith(tab.url));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Bookmark this page" }).getAttribute("aria-pressed")).toBe("false");
    expect(useBrowser.getState().notice).toBe("Bookmark removed");
    expect(contentCoverDepth()).toBe(0);
  });

  it("follows a removal made elsewhere, such as the Library", async () => {
    vi.mocked(ipc.bookmarkStatus).mockResolvedValue(true);
    render(<BookmarkButton />);
    expect(await screen.findByRole("button", { name: "Edit bookmark" })).toBeTruthy();
    vi.mocked(ipc.bookmarkStatus).mockResolvedValue(false);
    act(() => void window.dispatchEvent(new CustomEvent(BOOKMARKS_CHANGED)));
    expect(await screen.findByRole("button", { name: "Bookmark this page" })).toBeTruthy();
  });

  it("closes on Escape and on an outside press, keeping the bookmark", async () => {
    await openPopover();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit bookmark" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit bookmark" }));
    // Reopened on a lit star: the popover is for editing now.
    await screen.findByRole("dialog", { name: "Edit bookmark" });
    // The outside-press listener is attached in an effect after the popover
    // commits, so give it a tick before pressing.
    await waitFor(() => act(() => void fireEvent.mouseDown(document.body)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ipc.bookmarkRemove).not.toHaveBeenCalled();
  });
});
