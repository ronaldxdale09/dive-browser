import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderTabs, TabStrip } from "./TabStrip";
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
});
