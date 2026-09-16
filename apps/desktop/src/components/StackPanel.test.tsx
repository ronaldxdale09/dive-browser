import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { StackPanel } from "./StackPanel";

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1", detached: [] });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("StackPanel", () => {
  it("does not keep a detached tab's stack as this window's dock", async () => {
    vi.spyOn(ipc, "tabStack").mockResolvedValue({
      technologies: [{ name: "React", category: "framework", version: "18", evidence: ["window.React"] }],
      generator: null,
      server_rendered: false,
      packages: [],
    });
    render(<StackPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Detect stack/ }));
    expect(await screen.findByText(/1 found/)).toBeTruthy();
    act(() => useBrowser.setState({ detached: ["t1"] }));
    expect(screen.queryByText(/1 found/)).toBeNull();
    expect(screen.getByText("Detect what this page is built with.")).toBeTruthy();
  });
});
