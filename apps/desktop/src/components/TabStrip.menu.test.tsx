import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { TabStrip } from "./TabStrip";

const tab: Tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "Alpha", favicon: null, tier: "today", position: 0, created_at: "", last_active_at: "", state: "active", scroll_x: 0, scroll_y: 0 } as Tab;

afterEach(() => vi.restoreAllMocks());

describe("tab context menu", () => {
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
