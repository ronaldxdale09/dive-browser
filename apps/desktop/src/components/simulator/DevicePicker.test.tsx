import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { resetPushed, useEmulation } from "../../store/emulation";
import { usePicker } from "../../store/simulator";
import { DevicePicker } from "./DevicePicker";

const tab: Tab = {
  id: "tab-1",
  workspace_id: "workspace-1",
  tier: "today",
  url: "https://example.com/docs",
  title: "Example",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-03T00:00:00Z",
};

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, activeWorkspace: tab.workspace_id, error: null });
  useEmulation.setState({ byTab: {}, scale: {}, media: {}, throttle: {}, environment: {}, recent: [] });
  usePicker.setState({ open: true });
  resetPushed();
  vi.spyOn(ipc, "tabEmulate").mockResolvedValue(null);
  vi.spyOn(ipc, "tabMedia").mockResolvedValue(null);
  vi.spyOn(ipc, "tabThrottle").mockResolvedValue(null);
  vi.spyOn(ipc, "tabEnvironment").mockResolvedValue(null);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DevicePicker", () => {
  it("lists every group with its devices", () => {
    render(<DevicePicker />);
    for (const group of ["Apple phones", "Android phones", "Foldables", "Tablets", "Laptops and desktops"]) {
      expect(screen.getByText(group)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /iPhone 15 393×852/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pixel 8/ })).toBeTruthy();
  });

  it("sits beside the page rather than over it, so the page stays visible", () => {
    render(<DevicePicker />);
    expect(screen.getByRole("region", { name: "Device simulator" })).toBeTruthy();
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
  });

  it("filters by search and says when nothing matches", () => {
    render(<DevicePicker />);
    const search = screen.getByPlaceholderText(/Search devices/);
    fireEvent.change(search, { target: { value: "pixel" } });
    expect(screen.queryByRole("button", { name: /iPhone 15/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Pixel 8/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText(/No device matches/)).toBeTruthy();
  });

  it("puts a chosen device on the stage in its browser, and remembers it", () => {
    render(<DevicePicker />);
    fireEvent.click(screen.getByRole("button", { name: /iPhone 15 393×852/ }));
    const sel = useEmulation.getState().byTab[tab.id];
    expect(sel).toMatchObject({ deviceId: "iphone-15", landscape: false, ui: "browser", zoom: "fit" });
    expect(useEmulation.getState().recent).toEqual(["iphone-15"]);
    // The engine is not told yet: the stage has to measure a scale first.
    expect(ipc.tabEmulate).not.toHaveBeenCalled();
  });

  it("starts a laptop with nothing drawn around the page", () => {
    render(<DevicePicker />);
    fireEvent.click(screen.getByRole("button", { name: /Laptop 1366/ }));
    expect(useEmulation.getState().byTab[tab.id]?.ui).toBe("none");
  });

  it("turns the simulator off and tells the engine at once", async () => {
    useEmulation.setState({ byTab: { [tab.id]: { deviceId: "iphone-15", landscape: false, ui: "browser", zoom: "fit" } } });
    await useEmulation.getState().setScale(tab.id, 1);
    vi.mocked(ipc.tabEmulate).mockClear();
    render(<DevicePicker />);
    fireEvent.click(screen.getByRole("button", { name: /Off — fill the window/ }));
    expect(useEmulation.getState().byTab[tab.id]).toBeUndefined();
    await vi.waitFor(() => expect(ipc.tabEmulate).toHaveBeenCalledWith(tab.id, null, true));
  });

  it("applies a custom size as a bare viewport", async () => {
    render(<DevicePicker />);
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "700" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(useEmulation.getState().byTab[tab.id]).toMatchObject({ deviceId: "custom", ui: "none", custom: { width: 1000, height: 700 } });
    await vi.waitFor(() => expect(ipc.tabEmulate).toHaveBeenCalledWith(tab.id, expect.objectContaining({ width: 1000, height: 700, user_agent: "" }), false));
  });

  it("sets appearance, network and place from the panel", async () => {
    render(<DevicePicker />);
    fireEvent.click(screen.getByRole("button", { name: /Dark/ }));
    fireEvent.click(screen.getByRole("button", { name: /Slow 3G/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tokyo" }));
    await vi.waitFor(() => {
      expect(ipc.tabMedia).toHaveBeenCalledWith(tab.id, expect.objectContaining({ color_scheme: "dark" }));
      expect(ipc.tabThrottle).toHaveBeenCalledWith(tab.id, "slow3g");
      expect(ipc.tabEnvironment).toHaveBeenCalledWith(tab.id, expect.objectContaining({ timezone: "Asia/Tokyo", locale: "ja_JP" }));
    });
  });

  it("closes on Escape and on the close button", () => {
    render(<DevicePicker />);
    fireEvent.click(screen.getByRole("button", { name: "Close device simulator" }));
    expect(usePicker.getState().open).toBe(false);
    act(() => usePicker.setState({ open: true }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(usePicker.getState().open).toBe(false);
  });
});
