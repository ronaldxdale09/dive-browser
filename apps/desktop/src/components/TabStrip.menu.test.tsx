import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { TabStrip, narrowSample, roveMenu } from "./TabStrip";

const tab: Tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "Alpha", favicon: null, tier: "today", position: 0, created_at: "", last_active_at: "", state: "active", scroll_x: 0, scroll_y: 0 } as Tab;

const initial = useBrowser.getState();

afterEach(() => {
  cleanup();
  // A test may stand in for a store action; the next one gets the real ones.
  useBrowser.setState(initial, true);
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

  it("moves the menu up by its measured height when it would run off the bottom", () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(208);
    useBrowser.setState({ tabs: [tab], activeTab: "t1", activeWorkspace: "w1" });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }), { clientX: 40, clientY: window.innerHeight - 10 });
    expect(screen.getByRole("menu", { name: "Tab actions" }).style.top).toBe(`${window.innerHeight - 320 - 12}px`);
  });

  it("hands focus to the neighbouring tab when Delete closes the focused one", () => {
    const second = { ...tab, id: "t2", title: "Beta", position: 1 } as Tab;
    const close = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ tabs: [tab, second], activeTab: "t1", activeWorkspace: "w1", closeTab: close });
    render(<TabStrip />);
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "Delete" });
    expect(close).toHaveBeenCalledWith("t1");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Beta/ }));
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
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Reload" }));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate tab" }));
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

  it("opens a duplicate beside its source, reloads, and closes the tabs to the right", async () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    vi.spyOn(ipc, "tabOpen").mockResolvedValue({ id: "copy" } as never);
    const reorder = vi.spyOn(ipc, "tabReorder").mockResolvedValue(null as never);
    const reload = vi.spyOn(ipc, "tabReload").mockResolvedValue(null as never);
    vi.spyOn(ipc, "tabScrollPosition").mockResolvedValue(null);
    const close = vi.spyOn(ipc, "tabClose").mockResolvedValue(null as never);
    const beta = { ...tab, id: "t2", title: "Beta", position: 1 } as Tab;
    const gamma = { ...tab, id: "t3", title: "Gamma", position: 2 } as Tab;
    useBrowser.setState({ tabs: [tab, beta, gamma], activeTab: "t1", activeWorkspace: "w1" });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate tab" }));
    await waitFor(() => expect(reorder).toHaveBeenCalledWith("w1", ["t1", "copy", "t2", "t3"]));
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Reload/ }));
    expect(reload).toHaveBeenCalledWith("t2");
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Beta/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close tabs to the right" }));
    await waitFor(() => expect(close.mock.calls.map((c) => c[0])).toEqual(["t3"]));
    // The last tab has nothing to its right.
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Gamma/ }));
    expect(screen.queryByRole("menuitem", { name: "Close tabs to the right" })).toBeNull();
  });

  it("moves a tab to another workspace of its profile, and says why not where it cannot go", async () => {
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    const move = vi.spyOn(ipc, "tabMoveToWorkspace").mockResolvedValue(null as never);
    const workspace = (id: string, name: string, container_id: string, profile_id = "p1") => ({ id, name, color: "#fff", icon: "home", container_id, profile_id, position: 0, created_at: "" });
    useBrowser.setState({
      tabs: [tab],
      activeTab: "t1",
      activeWorkspace: "w1",
      activeProfile: "p1",
      workspaces: [workspace("w1", "Home", "c1"), workspace("w2", "Work", "c1"), workspace("w3", "Bank", "c2"), workspace("w4", "Theirs", "c1", "p2")],
    });
    render(<TabStrip />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /Alpha/ }));
    const trigger = screen.getByRole("menuitem", { name: "Move to workspace" });
    trigger.focus();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const list = await screen.findByRole("menu", { name: "Move to workspace" });
    const names = Array.from(list.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(names).toEqual(["Work", "Bank. Keeps its own cookies and logins"]);
    expect(document.activeElement?.textContent).toBe("Work");
    fireEvent.click(screen.getByRole("menuitem", { name: /Bank/ }));
    expect(move).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "Move to workspace" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Work" }));
    expect(move).toHaveBeenCalledWith("t1", "w2");
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

describe("essential tabs", () => {
  it("say they are essential, so a screen reader can tell them from the workspace's tabs", () => {
    const essential = { ...tab, id: "e1", title: "Mail", tier: "essential", workspace_id: null } as unknown as typeof tab;
    useBrowser.setState({ tabs: [essential, { ...tab, id: "t1", title: "Docs" }], activeTab: "t1", activeWorkspace: "w1" });
    render(<TabStrip />);
    expect(screen.getByRole("tab", { name: "Mail, essential" }).getAttribute("title")).toBe("Mail (essential, in every workspace)");
    expect(screen.getByRole("tab", { name: /^Docs/ })).toBeTruthy();
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

  it("measures a squeezable tab, not the wider active one or a pinned icon", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ ...tab, id: `t${i}`, position: i, title: `Tab ${i}` }));
    const pinned = { ...tab, id: "p", tier: "pinned" as const, position: 0, title: "Pin" };
    expect(narrowSample([pinned, ...many], "t0")).toBe("t1");
    // The active tab is wide and a pinned one is a fixed icon; neither says how
    // narrow the rest are.
    useBrowser.setState({ tabs: [pinned, ...many], activeTab: "t0", activeWorkspace: "w1" });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const button = this.querySelector('[role="tab"]');
      const id = button instanceof HTMLElement ? button.dataset["tabId"] : undefined;
      const width = id === "t0" ? 128 : id === "p" ? 36 : 60;
      return { width, height: 30, top: 0, left: 0, right: width, bottom: 30, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    render(<TabStrip />);
    expect(screen.getByRole("tab", { name: /^Tab 2/ }).textContent).not.toContain("Tab 2");
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Tab 0");
    rect.mockRestore();
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
