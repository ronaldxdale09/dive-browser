import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderTabs, roveTab, TabStrip } from "./TabStrip";
import type { Tab } from "../lib/ipc";
import { useBrowser } from "../store/browser";

const t = (id: string, tier: Tab["tier"], position: number, state: Tab["state"] = "active"): Tab =>
  ({ id, workspace_id: "w", tier, url: "https://x", title: "", position, state, last_active_at: "2026-01-01T00:00:00Z" }) as Tab;
const initialBrowserState = useBrowser.getState();

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowserState, true);
  vi.restoreAllMocks();
});

describe("orderTabs", () => {
  it("puts pinned first, sorts by position, hides essentials, keeps sleeping tabs", () => {
    const out = orderTabs([t("c", "today", 2), t("p", "pinned", 9), t("a", "today", 0), t("e", "essential", 0), t("d", "today", 1, "discarded")]);
    expect(out.map((x) => x.id)).toEqual(["p", "a", "d", "c"]);
  });
});

describe("TabStrip controls", () => {
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

  it("closes a tab without activating it and keeps controls out of the window drag region", () => {
    const closeTab = vi.fn().mockResolvedValue(undefined);
    const activateTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ tabs: [{ ...t("a", "today", 0), title: "Example" }], activeTab: "a", closeTab, activateTab });

    const { container } = render(createElement(TabStrip));
    const close = screen.getByRole("button", { name: "Close Example" });
    fireEvent.pointerDown(close);
    fireEvent.click(close);

    expect(closeTab).toHaveBeenCalledWith("a");
    expect(activateTab).not.toHaveBeenCalled();
    expect(container.querySelector("[data-tauri-drag-region] button")).toBeNull();
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
