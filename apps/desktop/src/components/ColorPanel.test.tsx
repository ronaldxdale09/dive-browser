import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { ColorPanel } from "./ColorPanel";

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

describe("ColorPanel", () => {
  it("does not keep a detached tab's palette as this window's dock", async () => {
    vi.spyOn(ipc, "tabPalette").mockResolvedValue({
      colors: [{ hex: "#111111", alpha: 1, count: 4, role: "background", sample: "body" }],
      theme_color: null,
      scanned: 12,
    });
    render(<ColorPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Page palette/ }));
    expect(await screen.findByText("1 colours · 12 elements")).toBeTruthy();
    act(() => useBrowser.setState({ detached: ["t1"] }));
    expect(screen.queryByText("1 colours · 12 elements")).toBeNull();
    expect(screen.getByText("Pick a colour from anywhere on the page, or read the palette it uses.")).toBeTruthy();
  });
});
