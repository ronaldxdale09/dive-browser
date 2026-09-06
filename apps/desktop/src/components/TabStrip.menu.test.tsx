import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { TabStrip } from "./TabStrip";

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
});
