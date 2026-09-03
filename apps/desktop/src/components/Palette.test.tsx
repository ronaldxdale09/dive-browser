import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { Palette } from "./Palette";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Palette", () => {
  it("is an accessible new-tab dialog with a URL field and recent history", async () => {
    vi.spyOn(ipc, "commandsList").mockResolvedValue([]);
    vi.spyOn(ipc, "devServers").mockResolvedValue([]);
    vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([]);
    vi.spyOn(ipc, "historySearch").mockResolvedValue([
      {
        url: "https://example.com/docs",
        title: "Example docs",
        last_visited_at: "2026-09-03T00:00:00Z",
        visits: 3,
        favicon: null,
      },
    ]);

    render(<Palette />);

    expect(screen.getByRole("dialog", { name: "New tab" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search, enter a URL, or run a command")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());
    expect(screen.getByText("History")).toBeTruthy();
  });
});
