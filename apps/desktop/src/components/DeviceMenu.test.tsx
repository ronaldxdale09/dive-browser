import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tab } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useEmulation } from "../store/emulation";
import { DeviceMenu } from "./DeviceMenu";

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initialBrowser = useBrowser.getState();
const initialEmulation = useEmulation.getState();
const device = { deviceId: "iphone-15", landscape: false, ui: "browser" as const, zoom: "fit" as const };

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1", detached: [] });
  useEmulation.setState({ byTab: { t1: device } });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowser, true);
  useEmulation.setState(initialEmulation, true);
});

describe("DeviceMenu", () => {
  it("does not light the simulator for a detached tab", () => {
    useBrowser.setState({ tabs: [tab], activeTab: "t1", detached: ["t1"] });
    render(<DeviceMenu />);
    const button = screen.getByRole("button", { name: "Device simulator" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
