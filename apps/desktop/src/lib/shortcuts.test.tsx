import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "./ipc";
import { events, ipc } from "./ipc";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { useShortcuts } from "./shortcuts";

const tab: Tab = {
  id: "t1",
  workspace_id: "w",
  tier: "today",
  url: "https://example.com",
  title: "Example",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-04T00:00:00Z",
};

function Harness() {
  useShortcuts();
  return null;
}

beforeEach(() => {
  vi.spyOn(events.menuCommand, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(ipc, "tabStop").mockResolvedValue(null);
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, detached: [], loading: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useShortcuts", () => {
  it("does not consume Escape as Stop for a detached tab's load", () => {
    useBrowser.setState({ tabs: [tab], activeTab: tab.id, detached: [tab.id], loading: { [tab.id]: true } });
    expect(tabInThisWindow(useBrowser.getState().activeTab, useBrowser.getState().detached)).toBeNull();
    render(<Harness />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(ipc.tabStop).not.toHaveBeenCalled();
  });
});
