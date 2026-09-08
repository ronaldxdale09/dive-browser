import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { resetPushed, useEmulation } from "../../store/emulation";
import { DeviceStage } from "./DeviceStage";

const tab: Tab = {
  id: "tab-1",
  workspace_id: "workspace-1",
  tier: "today",
  url: "https://x.com/home",
  title: "X",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-03T00:00:00Z",
};

const iphone = { deviceId: "iphone-15", landscape: false, ui: "browser" as const, zoom: "fit" as const };

/** jsdom lays nothing out; give the stage a size so a scale can be computed. */
function stubSize(width: number, height: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
}

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, activeWorkspace: tab.workspace_id, error: null, notice: null });
  useEmulation.setState({ byTab: { [tab.id]: iphone }, scale: {}, media: {}, throttle: {}, environment: {}, recent: [] });
  resetPushed();
  stubSize(1200, 800);
  vi.spyOn(ipc, "tabEmulate").mockResolvedValue(null);
  vi.spyOn(ipc, "tabMedia").mockResolvedValue(null);
  vi.spyOn(ipc, "setContentBounds").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeviceStage", () => {
  it("draws the device, its bars, and the viewport Safari would give", async () => {
    render(<DeviceStage tabId={tab.id} sel={iphone} />);
    expect(screen.getByLabelText("iPhone 15")).toBeTruthy();
    // The Safari address pill shows the host, not the URL.
    expect(screen.getAllByText("x.com").length).toBeGreaterThan(0);
    // Caption states the real viewport and the scale it is drawn at.
    expect(screen.getByText(/iPhone 15 · viewport 393×659 @3x · shown at \d+%/)).toBeTruthy();
    // The engine hears about the device once the scale is measured, with a
    // reload because the user agent changed from nothing to an iPhone.
    await vi.waitFor(() => expect(ipc.tabEmulate).toHaveBeenCalledWith(tab.id, expect.objectContaining({ width: 393, height: 659, user_agent: expect.stringContaining("iPhone") }), true));
  });

  it("fits a tall phone into a short stage by scaling it, not by lying about the viewport", async () => {
    stubSize(1200, 500);
    render(<DeviceStage tabId={tab.id} sel={iphone} />);
    await vi.waitFor(() => expect(ipc.tabEmulate).toHaveBeenCalled());
    const input = vi.mocked(ipc.tabEmulate).mock.calls[0]?.[1];
    expect(input?.height).toBe(659);
    expect(input?.scale).toBeLessThan(1);
    expect(input?.scale).toBeGreaterThan(0);
  });

  it("reports the page slot's rectangle as the content bounds", async () => {
    render(<DeviceStage tabId={tab.id} sel={iphone} />);
    await vi.waitFor(() => expect(ipc.setContentBounds).toHaveBeenCalled());
  });

  it("rotates on R without reloading", async () => {
    render(<DeviceStage tabId={tab.id} sel={iphone} />);
    await vi.waitFor(() => expect(ipc.tabEmulate).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: "r" });
    expect(useEmulation.getState().byTab[tab.id]?.landscape).toBe(true);
    await vi.waitFor(() => expect(ipc.tabEmulate).toHaveBeenCalledTimes(2));
    const [, input, reload] = vi.mocked(ipc.tabEmulate).mock.calls[1]!;
    expect(input).toMatchObject({ width: 852, height: 322 });
    expect(reload).toBe(false);
  });

  it("ignores R while typing in a field", () => {
    render(
      <>
        <input aria-label="Somewhere to type" />
        <DeviceStage tabId={tab.id} sel={iphone} />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("Somewhere to type"), { key: "r" });
    expect(useEmulation.getState().byTab[tab.id]?.landscape ?? false).toBe(false);
  });

  it("cycles what is drawn around the page and tells the page it is installed", async () => {
    useEmulation.setState({ byTab: { [tab.id]: iphone } });
    render(<DeviceStage tabId={tab.id} sel={iphone} />);
    fireEvent.click(screen.getByRole("button", { name: /Around the page/ }));
    expect(useEmulation.getState().byTab[tab.id]?.ui).toBe("standalone");
    await vi.waitFor(() => expect(ipc.tabMedia).toHaveBeenCalledWith(tab.id, expect.objectContaining({ display_mode: "standalone" })));
  });

  it("leaves the simulator from the tool strip", async () => {
    useEmulation.setState({ byTab: { [tab.id]: iphone } });
    render(<DeviceStage tabId={tab.id} sel={iphone} />);
    fireEvent.click(screen.getByRole("button", { name: "Leave the simulator" }));
    expect(useEmulation.getState().byTab[tab.id]).toBeUndefined();
    await vi.waitFor(() => expect(ipc.tabEmulate).toHaveBeenLastCalledWith(tab.id, null, true));
  });

  it("draws Chrome's bars for an Android phone", () => {
    const pixel = { ...iphone, deviceId: "pixel-8" };
    useEmulation.setState({ byTab: { [tab.id]: pixel } });
    render(<DeviceStage tabId={tab.id} sel={pixel} />);
    expect(screen.getByLabelText("Pixel 8")).toBeTruthy();
    expect(screen.getByText(/Pixel 8 · viewport 412×811 @2.625x/)).toBeTruthy();
  });
});
