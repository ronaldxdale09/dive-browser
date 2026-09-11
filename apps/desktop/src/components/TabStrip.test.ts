import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countOutOfView, essentialTabs, revealScrollLeft, revealScrollTop, orderTabs, roveTab, splitAction, tabLabel, TabStrip } from "./TabStrip";
import type { Tab } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { ipc } from "../lib/ipc";

const t = (id: string, tier: Tab["tier"], position: number, state: Tab["state"] = "active"): Tab =>
  ({ id, workspace_id: "w", tier, url: "https://x", title: "", position, state, last_active_at: "2026-01-01T00:00:00Z" }) as Tab;
const initialBrowserState = useBrowser.getState();

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowserState, true);
  vi.restoreAllMocks();
});

describe("orderTabs", () => {
  it("puts pinned first, sorts by position, leaves essentials to their rail, keeps sleeping tabs", () => {
    const all = [t("c", "today", 2), t("p", "pinned", 9), t("a", "today", 0), t("e2", "essential", 1), t("e", "essential", 0), t("d", "today", 1, "discarded")];
    expect(orderTabs(all).map((x) => x.id)).toEqual(["p", "a", "d", "c"]);
    expect(essentialTabs(all).map((x) => x.id)).toEqual(["e", "e2"]);
  });
});

describe("tab style", () => {
  it("marks tabs with the tab-item class and the active one with data-active, leaving the look to the stylesheet", () => {
    useBrowser.setState({ tabs: [{ ...t("a", "today", 0), title: "Docs" }, { ...t("b", "today", 1), title: "Mail" }], activeTab: "a" });
    render(createElement(TabStrip));
    const items = screen.getByRole("tablist", { name: "Tabs" }).querySelectorAll(".tab-item");
    expect(items.length).toBe(2);
    expect(items[0]!.hasAttribute("data-active")).toBe(true);
    expect(items[1]!.hasAttribute("data-active")).toBe(false);
    // No per-style conditionals in the markup: flat vs pill is `data-tab-style` on the root.
    expect(items[0]!.className).not.toContain("bg-surface-2");
    expect(items[0]!.className).toContain("h-[calc(var(--row-h)-4px)]");
  });
});

describe("Essentials rail", () => {
  it("shows essentials icon-only ahead of the strip, behind a divider, and activates on click", () => {
    const activateTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ tabs: [{ ...t("e", "essential", 0), title: "Mail", workspace_id: null }, { ...t("a", "today", 0), title: "Docs" }], activeTab: "a", activateTab });
    const { container } = render(createElement(TabStrip));

    const rail = screen.getByRole("tablist", { name: "Essentials" });
    const essential = rail.querySelector('[role="tab"]')!;
    expect(essential.getAttribute("data-essential")).not.toBeNull();
    expect(essential.textContent).toBe("");
    expect(essential.getAttribute("title")).toBe("Mail (essential, in every workspace)");
    // Icon-only on screen, but named for a screen reader, tier included.
    expect(essential.getAttribute("aria-label")).toBe("Mail, essential");
    const divider = screen.getByTestId("essentials-divider");
    expect(rail.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(screen.getByRole("tablist", { name: "Tabs" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Essentials stay out of the sortable strip.
    expect(screen.getByRole("tablist", { name: "Tabs" }).querySelectorAll('[role="tab"]').length).toBe(1);
    expect(container.querySelector('[data-tauri-drag-region="true"] [role=tab]')).toBeNull();

    fireEvent.click(essential);
    expect(activateTab).toHaveBeenCalledWith("e");
  });

  it("renders no rail when nothing is essential", () => {
    useBrowser.setState({ tabs: [t("a", "today", 0)], activeTab: "a" });
    render(createElement(TabStrip));
    expect(screen.queryByRole("tablist", { name: "Essentials" })).toBeNull();
    expect(screen.queryByTestId("essentials-divider")).toBeNull();
  });

  it("makes a tab essential and back from the context menu", () => {
    const setTier = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    useBrowser.setState({ tabs: [{ ...t("e", "essential", 0), workspace_id: null }, { ...t("a", "today", 0), title: "Docs" }], activeTab: "a", setTier });
    render(createElement(TabStrip));

    // dnd-kit's attributes give the strip tab a composite name, so go by its title.
    fireEvent.contextMenu(screen.getByText("Docs").closest('[role="tab"]')!);
    expect(screen.getByRole("menuitem", { name: "Pin tab" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make essential" }));
    expect(setTier).toHaveBeenCalledWith("a", "essential");

    fireEvent.contextMenu(screen.getByRole("tablist", { name: "Essentials" }).querySelector('[role="tab"]')!);
    expect(screen.queryByRole("menuitem", { name: /Pin tab|Unpin tab/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from essentials" }));
    expect(setTier).toHaveBeenCalledWith("e", "today");
  });
});

describe("TabStrip controls", () => {
  it("keeps a tab gesture away from Tauri's document-level window drag listener", () => {
    useBrowser.setState({ tabs: [{ ...t("a", "today", 0), title: "Example" }], activeTab: "a" });
    const reachedDocument = vi.fn();
    document.addEventListener("mousedown", reachedDocument);
    try {
      const { container } = render(createElement(TabStrip));
      const tab = screen.getByRole("tab");

      fireEvent.mouseDown(tab, { button: 0 });

      expect(reachedDocument).not.toHaveBeenCalled();
      expect(tab.closest("[data-tab-drag-handle]")?.getAttribute("data-tauri-drag-region")).toBe("false");
      expect(container.querySelectorAll('[data-tauri-drag-region="true"]')).toHaveLength(1);

      fireEvent.mouseDown(container.querySelector('[data-tauri-drag-region="true"]')!, { button: 0 });
      expect(reachedDocument).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("mousedown", reachedDocument);
    }
  });

  it("shows a sleeping tab dimmed and wakes it on click", () => {
    const activateTab = vi.fn();
    useBrowser.setState({ tabs: [t("d", "today", 0, "discarded")], activeTab: null, activateTab });

    render(createElement(TabStrip));

    const tab = screen.getByRole("tab");
    expect(tab.dataset.sleeping).toBe("true");
    expect(screen.getByLabelText("Sleeping")).toBeTruthy();
    fireEvent.click(tab);
    expect(activateTab).toHaveBeenCalledWith("d");
  });

  it("opens the URL and history dialog from the persistent new-tab button", () => {
    const toggle = vi.fn();
    useBrowser.setState({ tabs: [], activeTab: null, toggle });

    render(createElement(TabStrip));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));

    expect(toggle).toHaveBeenCalledWith("palette", true);
  });

  it("counts the tabs scrolled out of the strip", () => {
    // Screen-space: the strip starts 400px into the window, like the real one.
    const items = [400, 460, 520, 580, 640].map((left) => ({ left, right: left + 56 }));
    expect(countOutOfView({ left: 400, right: 700 }, items)).toBe(0);
    expect(countOutOfView({ left: 400, right: 600 }, items)).toBe(2);
    // Scrolled to the end: the first two are gone past the left edge.
    expect(countOutOfView({ left: 500, right: 700 }, items)).toBe(2);
    // Rounding slack: a tab flush with the edge still counts as in view.
    expect(countOutOfView({ left: 400, right: 696.5 }, items)).toBe(0);
  });

  it("reveals a tab by scrolling the strip the least amount, and leaves a visible tab alone", () => {
    const list = { left: 400, right: 700, scrollLeft: 120 };
    expect(revealScrollLeft(list, { left: 450, right: 510 })).toBe(120);
    expect(revealScrollLeft(list, { left: 380, right: 440 })).toBe(100);
    expect(revealScrollLeft(list, { left: 680, right: 740 })).toBe(160);
  });

  it("reveals a tab in vertical mode by scrolling the strip vertically", () => {
    const list = { top: 100, bottom: 400, scrollTop: 50 };
    expect(revealScrollTop(list, { top: 150, bottom: 200 })).toBe(50);
    expect(revealScrollTop(list, { top: 80, bottom: 120 })).toBe(30);
    expect(revealScrollTop(list, { top: 380, bottom: 420 })).toBe(70);
  });

  it("offers a way to the tabs that scrolled out of view, none when they all fit", () => {
    useBrowser.setState({ tabs: [t("a", "today", 0), t("b", "today", 1)], activeTab: "a", toggle: vi.fn() });
    render(createElement(TabStrip));
    // jsdom lays nothing out: every tab is at 0×0, so all are in view.
    expect(screen.queryByRole("button", { name: /out of view/ })).toBeNull();
  });

  it("closes a tab without activating it and keeps controls out of the window drag region", () => {
    const closeTab = vi.fn().mockResolvedValue(undefined);
    const activateTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ tabs: [{ ...t("a", "today", 0), title: "Example" }, { ...t("p", "pinned", 1), title: "Pinned" }], activeTab: "a", closeTab, activateTab });

    const { container } = render(createElement(TabStrip));
    const tab = screen.getByRole("tab", { name: "Example" });
    const closeBtn = screen.getByRole("button", { name: "Close Example" });
    expect(closeBtn).toBeTruthy();
    fireEvent.pointerDown(closeBtn);
    fireEvent.click(closeBtn);

    expect(closeTab).toHaveBeenCalledWith("a");
    expect(activateTab).not.toHaveBeenCalled();

    // Delete key closes tab
    fireEvent.keyDown(tab, { key: "Delete" });
    expect(closeTab).toHaveBeenCalledTimes(2);

    // Backspace key also closes tab
    fireEvent.keyDown(tab, { key: "Backspace" });
    expect(closeTab).toHaveBeenCalledTimes(3);

    // Middle click closes unpinned tab
    fireEvent(tab.parentElement!, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(closeTab).toHaveBeenCalledTimes(4);

    // Middle click on pinned tab does NOT close it
    const pinnedTab = screen.getByRole("tab", { name: "Pinned" });
    fireEvent(pinnedTab.parentElement!, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(closeTab).toHaveBeenCalledTimes(4);

    expect(container.querySelector('[data-tauri-drag-region="true"] button')).toBeNull();
  });

  it("swaps the favicon for a spinner while the tab loads", () => {
    useBrowser.setState({ tabs: [t("a", "today", 0)], activeTab: "a", loading: { a: true } });
    render(createElement(TabStrip));
    const spinner = screen.getByRole("img", { name: "Loading" });
    expect(spinner.className).toContain("animate-spin");
    expect(spinner.className).toContain("motion-reduce:animate-none");
    expect(spinner.querySelector("svg")).toBeTruthy();
  });

  it("puts one tab in the Tab order and moves focus with the arrow keys", () => {
    const activateTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ tabs: [t("a", "today", 0), t("b", "today", 1), t("c", "today", 2)], activeTab: "b", activateTab });
    render(createElement(TabStrip));

    const list = screen.getByRole("tablist", { name: "Tabs" });
    expect(getComputedStyle(list).display).not.toBe("contents");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.tabIndex)).toEqual([-1, 0, -1]);

    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    // Focus moved, the Tab stop follows it, and nothing was activated.
    expect(screen.getAllByRole("tab").map((el) => el.tabIndex)).toEqual([-1, -1, 0]);
    expect(activateTab).not.toHaveBeenCalled();

    fireEvent.keyDown(tabs[2]!, { key: " " });
    expect(activateTab).toHaveBeenCalledWith("c");
    fireEvent.keyDown(tabs[0]!, { key: "Enter" });
    expect(activateTab).toHaveBeenCalledWith("a");
  });

  it("gives the first essential tab tabIndex 0 when a regular tab is active and roves between them and main tabs", () => {
    useBrowser.setState({
      tabs: [
        { ...t("e1", "essential", 0), title: "Essential 1" },
        { ...t("e2", "essential", 1), title: "Essential 2" },
        { ...t("t1", "today", 2), title: "Tab 1" },
      ],
      activeTab: "t1",
    });
    render(createElement(TabStrip));

    const essentialList = screen.getByRole("tablist", { name: "Essentials" });
    const essentialTabs = essentialList.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(essentialTabs.length).toBe(2);
    // When a regular tab is active, the first essential tab has tabIndex 0 so it's reachable by Tab
    expect(essentialTabs[0]!.tabIndex).toBe(0);
    expect(essentialTabs[1]!.tabIndex).toBe(-1);

    // Arrow keys inside essentials move focus
    essentialTabs[0]!.focus();
    fireEvent.keyDown(essentialTabs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(essentialTabs[1]);

    // Arrow right on last essential tab moves into the main tab strip
    const mainTab = screen.getByRole("tab", { name: "Tab 1" });
    fireEvent.keyDown(essentialTabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(mainTab);

    // Arrow left on first main tab moves back to last essential tab
    fireEvent.keyDown(mainTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(essentialTabs[1]);
  });

  it("ignores arrow keys that were not pressed on a tab", () => {
    const list = document.createElement("div");
    const tab = document.createElement("div");
    tab.setAttribute("role", "tab");
    const button = document.createElement("button");
    tab.appendChild(button);
    list.appendChild(tab);
    expect(roveTab("ArrowRight", list, button)).toBeNull();
    expect(roveTab("ArrowRight", list, tab)).toBe(tab);
    expect(roveTab("a", list, tab)).toBeNull();
  });
});

describe("splitAction", () => {
  const a = { ...t("a", "today", 0), title: "Alpha" };
  const b = { ...t("b", "today", 1), title: "Beta" };
  const c = { ...t("c", "today", 2), title: "A very long page title that keeps going" };
  const tabs = [a, b, c];

  it("splits an inactive tab with the active one, named after it", () => {
    const action = splitAction(b, "a", undefined, tabs, []);
    expect(action).toMatchObject({ kind: "with", anchor: "a", index: 1, label: "Split with “Alpha”" });
    expect(action?.kind === "with" && action.partner.id).toBe("a");
  });

  it("splits the active tab with its neighbour, preferring the one after it", () => {
    expect(splitAction(a, "a", undefined, tabs, [])).toMatchObject({ kind: "with", anchor: "a", label: "Split with “Beta”" });
    expect(splitAction(c, "c", undefined, tabs, [])).toMatchObject({ kind: "with", label: "Split with “Beta”" });
    expect(splitAction(a, "a", undefined, [a], [])).toBeNull();
  });

  it("shortens long partner names", () => {
    expect(splitAction(a, "c", undefined, tabs, [])).toMatchObject({ label: "Split with “A very long page titl…”" });
  });

  it("lets a pane leave and another tab join an existing split", () => {
    const split = { tabs: ["a", "b"], sizes: [0.5, 0.5] };
    expect(splitAction(a, "a", split, tabs, [])).toEqual({ kind: "leave" });
    expect(splitAction(c, "a", split, tabs, [])).toMatchObject({ kind: "with", index: 2, anchor: "a", label: "Add to split view" });
  });

  it("offers nothing for a tab in its own window, or when the split is full", () => {
    expect(splitAction(b, "a", undefined, tabs, ["b"])).toBeNull();
    expect(splitAction(b, "a", undefined, tabs, ["a"])).toBeNull();
    const d = t("d", "today", 3);
    const e = t("e", "today", 4);
    const full = { tabs: ["a", "b", "c", "d"], sizes: [0.25, 0.25, 0.25, 0.25] };
    expect(splitAction(e, "a", full, [...tabs, d, e], [])).toBeNull();
  });
});

describe("tabLabel", () => {
  it("names a loading tab after its host instead of the view's about:blank title", () => {
    expect(tabLabel({ ...t("a", "today", 0), title: "about:blank", url: "http://nonexistent.invalid/" })).toBe("nonexistent.invalid");
    expect(tabLabel({ ...t("a", "today", 0), title: "about:blank", url: "about:blank" })).toBe("about:blank");
    expect(tabLabel({ ...t("a", "today", 0), title: "Docs", url: "https://x" })).toBe("Docs");
  });
});
