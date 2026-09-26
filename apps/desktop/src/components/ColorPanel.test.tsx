import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useDockPanels } from "../store/dockPanels";
import { ColorPanel } from "./ColorPanel";

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1", detached: [] });
});

afterEach(() => {
  cleanup();
  useDockPanels.setState({ slots: {}, picked: null, recent: [] });
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

  it("says whether a copy worked, for picked colours and recent ones alike", async () => {
    const colour = (hex: string) => ({ hex, rgb: "rgb(0, 0, 0)", hsl: "hsl(0, 0%, 0%)", on_white: 21, on_black: 1 });
    vi.spyOn(ipc, "tabEyedropper").mockResolvedValueOnce(colour("#000000")).mockResolvedValueOnce(colour("#ffffff"));
    const write = vi.spyOn(ipc, "clipboardWriteText").mockRejectedValue(new Error("no clipboard"));
    const fallback = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
    render(<ColorPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Pick a colour" }));
    await screen.findByRole("button", { name: "Copy #000000" });
    fireEvent.click(screen.getByRole("button", { name: "Copy #000000" }));
    expect(await screen.findByRole("button", { name: "Could not copy #000000" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick a colour" }));
    await screen.findByText("Recent");
    write.mockResolvedValue(null as never);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy #000000" }).at(-1)!);
    expect(await screen.findByRole("button", { name: "#000000 copied" })).toBeTruthy();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: fallback });
  });
});
