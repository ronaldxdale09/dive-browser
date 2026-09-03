import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { Content } from "./Content";

// The welcome screen, the device simulator and its picker have tests of
// their own and lean on browser APIs jsdom lacks.
vi.mock("./Welcome", () => ({ Welcome: () => null }));
vi.mock("./simulator/DeviceStage", () => ({ DeviceStage: () => null }));
vi.mock("./simulator/DevicePicker", () => ({ DevicePicker: () => null }));

const tab: Tab = {
  id: "t1",
  workspace_id: "w1",
  tier: "today",
  url: "http://localhost:3000/",
  title: "",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-03T00:00:00Z",
};
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, activeWorkspace: tab.workspace_id, navError: {}, crashedTabs: {}, loading: {} });
  vi.spyOn(ipc, "setContentBounds").mockResolvedValue(null);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "appInfo").mockRejectedValue(new Error("no app"));
  vi.spyOn(ipc, "tabReload").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("Content error panel", () => {
  it("shows nothing over the page while the tab is healthy", () => {
    render(<Content />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
  });

  it("explains a refused connection, covers the page, and retries with a reload", () => {
    useBrowser.setState({ navError: { t1: { url: "http://localhost:3000/", error: "net::ERR_CONNECTION_REFUSED" } } });
    render(<Content />);

    const panel = screen.getByRole("alert");
    expect(panel.textContent).toContain("Connection refused");
    expect(panel.textContent).toContain("check it is running on port 3000");
    expect(panel.textContent).toContain("http://localhost:3000/");
    expect(contentCoverDepth()).toBe(1);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(ipc.tabReload).toHaveBeenCalledWith("t1");
  });

  it("uncovers the page once the error clears", () => {
    useBrowser.setState({ navError: { t1: { url: "https://nope.test/", error: "net::ERR_NAME_NOT_RESOLVED" } } });
    render(<Content />);
    expect(screen.getByRole("alert").textContent).toContain("This site can't be reached");
    expect(screen.getByRole("alert").textContent).toContain("DNS lookup failed");

    act(() => useBrowser.getState().applyLoad({ tab_id: "t1", phase: "started", url: "https://nope.test/", error: null }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });

  it("only speaks for the active tab", () => {
    useBrowser.setState({ navError: { other: { url: "https://x", error: "net::ERR_INTERNET_DISCONNECTED" } } });
    render(<Content />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Content crash banner", () => {
  it("reports a recovery in progress above the page without covering it", () => {
    useBrowser.setState({ crashedTabs: { t1: { attempt: 2, recovering: true } } });
    const { container } = render(<Content />);

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("renderer crashed — reloading (attempt 2)");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(contentCoverDepth()).toBe(0);
    // The banner is a sibling above the row holding the page, so the page's
    // reported rectangle starts below it rather than underneath it.
    const root = container.firstElementChild!;
    expect(root.firstElementChild).toBe(banner);
    expect(banner.contains(root.lastElementChild)).toBe(false);
  });

  it("offers a reload once Dive has given up", () => {
    useBrowser.setState({ crashedTabs: { t1: { attempt: 3, recovering: false } } });
    render(<Content />);
    expect(screen.getByRole("status").textContent).toContain("stopped reloading");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(ipc.tabReload).toHaveBeenCalledWith("t1");
  });

  it("goes away when the tab has a document again", () => {
    useBrowser.setState({ crashedTabs: { t1: { attempt: 1, recovering: true } } });
    render(<Content />);
    act(() => useBrowser.getState().applyLoad({ tab_id: "t1", phase: "stopped", url: null, error: null }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
