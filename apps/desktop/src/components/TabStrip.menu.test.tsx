import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { TabStrip, roveMenu } from "./TabStrip";

const tab: Tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "Alpha", favicon: null, tier: "today", position: 0, created_at: "", last_active_at: "", state: "active", scroll_x: 0, scroll_y: 0 } as Tab;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("tab context menu", () => {
  it("shows the chord beside the items that have one, without changing their names", () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    useBrowser.setState({ tabs: [tab], activeTab: "t1", activeWorkspace: "w1" });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }));
    const pin = screen.getByRole("menuitem", { name: "Pin tab" });
    expect(pin.getAttribute("aria-keyshortcuts")).toBe("mod+shift+p");
    expect(pin.querySelector("kbd")?.textContent).toBe("⌘⇧P");
    expect(screen.getByRole("menuitem", { name: "Open in new window" }).querySelector("kbd")?.textContent).toBe("⌘⌥N");
    expect(screen.getByRole("menuitem", { name: "Close tab" }).querySelector("kbd")?.textContent).toBe("⌘W");
    expect(screen.getByRole("menuitem", { name: "Close other tabs" }).querySelector("kbd")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Make essential" }).querySelector("kbd")).toBeNull();
  });

  it("closes on Escape and on a press outside the menu", async () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    useBrowser.setState({ tabs: [tab], activeTab: "t1", activeWorkspace: "w1" });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("takes focus, walks its items with the arrow keys, and gives focus back when it closes", async () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    useBrowser.setState({ tabs: [tab], activeTab: "t1", activeWorkspace: "w1" });
    render(<TabStrip />);
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    alpha.focus();
    fireEvent.contextMenu(alpha);
    expect(screen.getByRole("menu", { name: "Tab actions" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Pin tab" }));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Make essential" }));
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Close other tabs" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(alpha);
  });

  it("duplicates the tab and copies its address", async () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    const open = vi.spyOn(ipc, "tabOpen").mockResolvedValue({} as never);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    useBrowser.setState({ tabs: [tab], activeTab: "t1", activeWorkspace: "w1" });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate tab" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("w1", "https://a.test/"));
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy address" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("https://a.test/"));
    await waitFor(() => expect(useBrowser.getState().notice).toBe("Copied the address"));
  });

  it("roves with wrap-around and ignores other keys", () => {
    const a = document.createElement("button");
    const b = document.createElement("button");
    expect(roveMenu("ArrowDown", [a, b], b)).toBe(a);
    expect(roveMenu("ArrowUp", [a, b], a)).toBe(b);
    expect(roveMenu("ArrowUp", [a, b], null)).toBe(b);
    expect(roveMenu("End", [a, b], null)).toBe(b);
    expect(roveMenu("Enter", [a, b], a)).toBeNull();
    expect(roveMenu("ArrowDown", [], null)).toBeNull();
  });

  it("names a detached or sleeping tab's state for assistive tech", () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    useBrowser.setState({ tabs: [tab, { ...tab, id: "t2", title: "Beta", state: "discarded" } as Tab], activeTab: "t1", activeWorkspace: "w1", detached: ["t1"] });
    render(<TabStrip />);
    expect(screen.getByRole("tab", { name: "Alpha, in its own window" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Beta, sleeping" })).toBeTruthy();
  });
});

describe("crowded strip", () => {
  it("opens the tab search, not the plain palette, from the out-of-view badge", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...tab, id: `t${i}`, position: i, title: `Tab ${i}` }));
    const openPalette = vi.fn();
    useBrowser.setState({ tabs: many, activeTab: "t3", activeWorkspace: "w1", openPalette });
    // jsdom lays nothing out; pretend the last tabs sit past the strip's right edge.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // Each tab wrapper is 100px wide in a 600px strip, so the last two poke past its edge.
      const wrapper = this.getAttribute("role") === "presentation";
      const index = wrapper && this.parentElement ? Array.from(this.parentElement.children).indexOf(this) : -1;
      const left = index >= 0 ? index * 100 : 0;
      const right = index >= 0 ? left + 90 : 600;
      return { left, right, width: right - left, height: 30, top: 0, bottom: 30, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    render(<TabStrip />);
    const badge = screen.getByRole("button", { name: /out of view/ });
    rect.mockRestore();
    fireEvent.click(badge);
    expect(openPalette).toHaveBeenCalledWith("tabs");
  });

  it("keeps the active tab wide enough for a few words while the others give way", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...tab, id: `t${i}`, position: i, title: `Tab ${i}` }));
    useBrowser.setState({ tabs: many, activeTab: "t3", activeWorkspace: "w1" });
    render(<TabStrip />);
    const active = screen.getByRole("tab", { selected: true }).closest(".tab-item")!;
    const other = screen.getByRole("tab", { name: /^Tab 1/ }).closest(".tab-item")!;
    expect(active.className).toContain("min-w-32");
    expect(other.className).toContain("min-w-9");
    expect(other.className).not.toContain("min-w-32");
  });

  it("keeps the active tab's title when the others are down to a favicon", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...tab, id: `t${i}`, position: i, title: `Tab ${i}` }));
    useBrowser.setState({ tabs: many, activeTab: "t3", activeWorkspace: "w1" });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 60, height: 30, top: 0, left: 0, right: 60, bottom: 30, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    render(<TabStrip />);
    const active = screen.getByRole("tab", { selected: true });
    const other = screen.getByRole("tab", { name: /^Tab 1/ });
    expect(active.textContent).toContain("Tab 3");
    expect(other.textContent).not.toContain("Tab 1");
    expect(other.getAttribute("title")).toBe("Tab 1");
    rect.mockRestore();
  });
});
