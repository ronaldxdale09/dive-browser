import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { useDefaultBrowser } from "../store/defaultBrowser";
import { Rail, RailToggle } from "./Rail";

const personal: Workspace = {
  id: "ws-1",
  name: "Personal",
  color: "#7FD8C8",
  icon: "aurora",
  container_id: "container-1",
  profile_id: "profile-1",
  position: 0,
  created_at: "2026-09-03T00:00:00Z",
};
const client: Workspace = { ...personal, id: "ws-2", name: "Client", icon: "ember", container_id: "container-2", position: 1 };

beforeEach(() => {
  useBrowser.setState({
    workspaces: [personal, client],
    activeWorkspace: personal.id,
    counts: { [personal.id]: 3, [client.id]: 1 },
    editing: null,
    open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, shortcuts: false, menu: false, defaultBrowser: false, subtitles: false },
  });
  usePrefs.setState({ prefs: { ...DEFAULT_PREFS, rail_expanded: true }, loaded: true });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "defaultBrowserStatus").mockResolvedValue({ supported: true, is_default: false, current: "com.apple.Safari" });
  useDefaultBrowser.setState({ status: null, phase: "idle", error: null, declined: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Rail", () => {
  it("names each workspace and shows how many tabs it holds", () => {
    render(<Rail />);
    expect(screen.getByText("Workspaces")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Personal — 3 tabs/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Client — 1 tab, own cookies \(⌘2\)/ })).toBeTruthy();
  });

  it("switches workspace from the keyboard with Enter or Space", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ activateWorkspace: activate });
    render(<Rail />);
    const row = screen.getByRole("button", { name: /^Client/ });
    fireEvent.keyDown(row, { key: " " });
    expect(activate).toHaveBeenCalledWith(client.id);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("switches workspace on click", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ activateWorkspace: activate });
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: /^Client/ }));
    expect(activate).toHaveBeenCalledWith(client.id);
  });

  it("collapses to marks alone, and the choice is a preference", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    usePrefs.setState({ update });
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse the rail" }));
    expect(update).toHaveBeenCalledWith({ rail_expanded: false });

    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, rail_expanded: false } });
    await waitFor(() => expect(screen.queryByText("Workspaces")).toBeNull());
    expect(screen.queryByText("Personal")).toBeNull();
    const mark = screen.getByRole("button", { name: /^Personal — 3 tabs/ });
    // A bare mark explains itself on hover with the name, the count and the
    // chord, drawn above the scrolling list rather than clipped by it.
    expect(mark.getAttribute("title")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(mark.parentElement!);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Personal · 3 tabs");
    expect(tip.textContent).toContain("⌘1");
    expect(tip.parentElement).toBe(document.body);
    fireEvent.mouseLeave(mark.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand the rail" })).toBeTruthy();
  });

  it("leaves its inline collapse control out when the title strip hosts it", () => {
    render(<Rail toggle={false} />);
    expect(screen.queryByRole("button", { name: /the rail$/ })).toBeNull();
    // The strip renders the same control on its own.
    render(<RailToggle expanded />);
    expect(screen.getByRole("button", { name: "Collapse the rail" })).toBeTruthy();
  });

  it("confirms before deleting a workspace and its tabs", () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ deleteWorkspace: remove });
    render(<Rail />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Client/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete workspace" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete Client and close its 1 tab\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove).toHaveBeenCalledWith(client.id);
  });

  it("offers editing from the context menu instead of opening the dialog on right-click", () => {
    render(<Rail />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Personal/ }));
    expect(useBrowser.getState().editing).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit workspace…" }));
    expect(useBrowser.getState().editing).toEqual({ id: personal.id });
  });

  it("offers to make Dive the default browser above the profile and Settings, and can be put away", async () => {
    render(<Rail />);
    const offer = await screen.findByRole("button", { name: "Make Dive the default browser" });
    expect(offer.textContent).toContain("Set as default");
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(offer.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("default-browser-badge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(useDefaultBrowser.getState().declined).toBe(true);
    expect(screen.queryByRole("button", { name: "Make Dive the default browser" })).toBeNull();
  });

  it("lists the workspace's tabs under the workspaces, marks the current one, and closes from the row", () => {
    const activate = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({
      activeTab: "t2",
      activateTab: activate,
      closeTab: close,
      tabs: [
        { id: "t1", workspace_id: personal.id, tier: "today", url: "https://a.test/", title: "Alpha", favicon: null, position: 1, state: "active", last_active_at: "" },
        { id: "t2", workspace_id: personal.id, tier: "today", url: "https://b.test/", title: "Beta", favicon: null, position: 0, state: "active", last_active_at: "" },
        { id: "t3", workspace_id: null, tier: "essential", url: "https://mail.test/", title: "Mail", favicon: null, position: 0, state: "active", last_active_at: "" },
      ],
    });
    render(<Rail />);
    const list = screen.getByRole("region", { name: "Tabs" });
    const names = Array.from(list.querySelectorAll('[role="tab"]')).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Mail, essential", "Beta", "Alpha"]);
    expect(screen.getByRole("tablist", { name: "Tabs" }).getAttribute("aria-orientation")).toBe("vertical");
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    expect(activate).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }).parentElement!.querySelector("[data-close-tab]")!);
    expect(close).toHaveBeenCalledWith("t1");
    // The tab menu works here too.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Alpha" }));
    expect(screen.getByRole("menuitem", { name: /Close tab/ })).toBeTruthy();
  });

  it("shows the profile switcher at the foot of the rail, opening upward", () => {
    useBrowser.setState({ profiles: [{ id: "profile-1", name: "Ronald", avatar: "wave", color: "#7FD8C8", note: "", container_id: "container-1", position: 0, created_at: "" }], activeProfile: "profile-1" });
    render(<Rail />);
    const chip = screen.getByRole("button", { name: "Profile: Ronald" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(chip.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByRole("menu", { name: "Profiles" }).className).toContain("bottom-full");
  });

  it("stops offering once the person has said Not now", async () => {
    useDefaultBrowser.setState({ declined: true });
    render(<Rail />);
    await waitFor(() => expect(useDefaultBrowser.getState().status?.supported).toBe(true));
    expect(screen.queryByRole("button", { name: "Make Dive the default browser" })).toBeNull();
  });

  it("hides the default-browser entry when the build cannot ask", async () => {
    vi.mocked(ipc.defaultBrowserStatus).mockResolvedValue({ supported: false, is_default: false, current: null });
    render(<Rail />);
    await waitFor(() => expect(useDefaultBrowser.getState().status?.supported).toBe(false));
    expect(screen.queryByRole("button", { name: /default browser/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("disappears once Dive is the default", async () => {
    vi.mocked(ipc.defaultBrowserStatus).mockResolvedValue({ supported: true, is_default: true, current: "com.dive.browser" });
    render(<Rail />);
    await waitFor(() => expect(useDefaultBrowser.getState().status?.is_default).toBe(true));
    expect(screen.queryByRole("button", { name: /default browser/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("opens the default-browser dialog on click, and re-reads the status on focus", async () => {
    render(<Rail />);
    fireEvent.click(await screen.findByRole("button", { name: "Make Dive the default browser" }));
    expect(useBrowser.getState().open.defaultBrowser).toBe(true);
    const before = vi.mocked(ipc.defaultBrowserStatus).mock.calls.length;
    fireEvent(window, new Event("focus"));
    expect(vi.mocked(ipc.defaultBrowserStatus).mock.calls.length).toBe(before + 1);
  });
});
