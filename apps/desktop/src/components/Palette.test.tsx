import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import type { Tab } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { leadingSite, Palette, paletteFilter, ROW_ID } from "./Palette";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const initialBrowser = useBrowser.getState();
// cmdk scrolls the highlighted row into view; jsdom has no layout to scroll.
Element.prototype.scrollIntoView ??= () => undefined;

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowser, true);
  vi.restoreAllMocks();
});

describe("Palette", () => {
  it("offers rows that contain what was typed, not scattered-letter matches", () => {
    expect(paletteFilter("Developer dock dock.toggle", "verge")).toBe(0);
    expect(paletteFilter("The Verge https://www.theverge.com/", "verge")).toBe(1);
    expect(paletteFilter("Developer dock dock.toggle", "dev dock")).toBe(1);
    expect(paletteFilter("Device simulator simulator.toggle", "SIM")).toBe(1);
    expect(paletteFilter("open exam", "exam")).toBe(1);
    // A row's id tells duplicates apart but is not something to search by.
    expect(paletteFilter(`httpbin.org/json https://httpbin.org/json${ROW_ID}01a07e34`, "01a0")).toBe(0);
    expect(paletteFilter(`httpbin.org/json https://httpbin.org/json${ROW_ID}01a07e34`, "json")).toBe(1);
  });

  it("offers the site the letters begin first, ahead of the search row", async () => {
    vi.spyOn(ipc, "commandsList").mockResolvedValue([]);
    vi.spyOn(ipc, "devServersWatch").mockResolvedValue([]);
    vi.spyOn(events.devServersChanged, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([]);
    vi.spyOn(ipc, "historySearch").mockResolvedValue([{ url: "https://www.iana.org/help", title: "about:blank", last_visited_at: "2026-09-01T00:00:00Z", favicon: null, visits: 1 }]);
    const tab = { id: "t1", workspace_id: "w", url: "https://example.com/", title: "Example Domain", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "2026-09-01T00:00:00Z" } as unknown as Tab;
    useBrowser.setState({ tabs: [tab], activeTab: "t1" });
    render(<Palette />);
    const input = screen.getByPlaceholderText("Search, enter a URL, or run a command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "exam" } });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const rows = () => screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(rows()[0]).toContain("Example Domain");
    expect(rows()[0]).toContain("Switch to tab");
    expect(rows()[1]).toContain("Search");
    // The tab is not listed twice, and a blank recorded title falls back to the address.
    expect(rows().filter((r) => r.includes("Example Domain"))).toHaveLength(1);
    fireEvent.change(input, { target: { value: "iana" } });
    await waitFor(() => expect(rows()[0]).toContain("https://www.iana.org/help"));
    expect(rows()[0]).not.toContain("about:blank");
    // Typed as an address, the literal row stays first.
    expect(leadingSite("example.com", [tab], [], [])).toBeNull();
    expect(leadingSite("weather tokyo", [tab], [], [])).toBeNull();
  });

  it("leads with the open tabs when opened to find one", async () => {
    vi.spyOn(ipc, "commandsList").mockResolvedValue([]);
    vi.spyOn(ipc, "devServersWatch").mockResolvedValue([]);
    vi.spyOn(events.devServersChanged, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(ipc, "bookmarksSearch").mockResolvedValue([{ url: "https://docs.example.com/", title: "Example docs", created_at: "2026-09-01T00:00:00Z", favicon: null }]);
    vi.spyOn(ipc, "historySearch").mockResolvedValue([]);
    const tab = { id: "t1", workspace_id: "w", url: "https://a.test/", title: "Alpha", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "2026-09-01T00:00:00Z" } as unknown as Tab;
    useBrowser.setState({ tabs: [tab], activeTab: "t1" });
    useBrowser.getState().openPalette("tabs");
    expect(useBrowser.getState().paletteFocus).toBe("tabs");
    render(<Palette />);
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());
    const headings = Array.from(document.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent);
    expect(headings.indexOf("Tabs")).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf("Tabs")).toBeLessThan(headings.indexOf("Bookmarks"));

    // When typing a query, matching tabs precede the web search row
    const input = screen.getByPlaceholderText(/Search open tabs/);
    fireEvent.change(input, { target: { value: "alp" } });
    const rows = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(rows[0]).toContain("Alpha");

    // A plain open leads with everything again.
    useBrowser.getState().toggle("palette", true);
    expect(useBrowser.getState().paletteFocus).toBe("all");
  });

  it("is an accessible new-tab dialog with a URL field and recent history", async () => {
    vi.spyOn(ipc, "commandsList").mockResolvedValue([]);
    vi.spyOn(ipc, "devServersWatch").mockResolvedValue([]);
    vi.spyOn(events.devServersChanged, "listen").mockResolvedValue(() => undefined);
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

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search, enter a URL, or run a command")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Example docs")).toBeTruthy());
    expect(screen.getAllByText("History")).toHaveLength(2);
  });
});
