import { DndContext } from "@dnd-kit/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useLayout } from "../store/layout";
import { NUDGE, SplitView, nudgedSizes } from "./SplitView";

const tab = (id: string, title: string): Tab => ({ id, workspace_id: "ws", tier: "today", url: `https://${id}.test/`, title, favicon: null, position: 0, state: "active", last_active_at: "2026-09-04T00:00:00Z" });
const initialBrowser = useBrowser.getState();
const initialLayout = useLayout.getState();

beforeEach(() => {
  vi.spyOn(ipc, "setPanes").mockResolvedValue(null);
  useBrowser.setState({ tabs: [tab("a", "Docs"), tab("b", "App with a very long title that goes on")], activeTab: "a", activateTab: vi.fn().mockResolvedValue(undefined) });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowser, true);
  useLayout.setState(initialLayout, true);
  vi.restoreAllMocks();
});

describe("nudgedSizes", () => {
  it("moves a divider one step and keeps both panes above the minimum", () => {
    expect(nudgedSizes([0.5, 0.5], 0, 1)).toEqual([0.5 + NUDGE, 0.5 - NUDGE]);
    expect(nudgedSizes([0.2, 0.8], 0, -1)[0]).toBeCloseTo(0.15);
    expect(nudgedSizes([0.2, 0.8], 0, -1)[1]).toBeCloseTo(0.85);
    // Only the pair around the divider changes.
    expect(nudgedSizes([0.4, 0.3, 0.3], 1, 1)).toEqual([0.4, 0.35, 0.25]);
  });
});

describe("SplitView", () => {
  it("names the divider, says how the space is shared, and nudges it with the arrow keys", () => {
    const resize = vi.fn();
    useLayout.setState({ resize });
    render(
      <DndContext>
        <SplitView split={{ tabs: ["a", "b"], sizes: [0.5, 0.5] }} workspace="ws" />
      </DndContext>,
    );
    // A long title is shortened so the name stays sayable.
    const divider = screen.getByRole("separator", { name: /^Resize “Docs” and “App with a very long/ });
    expect(divider.getAttribute("aria-label")!.length).toBeLessThan(60);
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    expect(divider.getAttribute("aria-valuetext")).toBe("50% to the left pane");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(resize).toHaveBeenCalledWith("ws", [0.5 + NUDGE, 0.5 - NUDGE]);
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(resize).toHaveBeenLastCalledWith("ws", [0.5 - NUDGE, 0.5 + NUDGE]);
  });

  it("activates a pane from its header and closes a pane without closing the tab", () => {
    const remove = vi.fn();
    useLayout.setState({ remove });
    render(
      <DndContext>
        <SplitView split={{ tabs: ["a", "b"], sizes: [0.5, 0.5] }} workspace="ws" />
      </DndContext>,
    );
    fireEvent.click(screen.getByText(/^App with a very long/));
    expect(useBrowser.getState().activateTab).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: /^Close pane App/ }));
    expect(remove).toHaveBeenCalledWith("ws", "b");
    expect(useBrowser.getState().tabs).toHaveLength(2);
  });
});
