import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, WebApp } from "../lib/ipc";
import { events, ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { useWebApps } from "../store/webapps";
import { AppWindow } from "./AppWindow";

vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, tabInfo: vi.fn(), popoutReady: vi.fn(), webappForWindow: vi.fn(), webappIcon: vi.fn(), tabAttach: vi.fn(), webappUninstall: vi.fn(), webappsList: vi.fn() } };
});

const app: WebApp = { id: "https://mail.example/", name: "Mail by Example", short_name: "Mail", start_url: "https://mail.example/inbox", scope: "https://mail.example/", display: "standalone", theme_color: null, background_color: null, icon_path: "/data/icon.png", manifest_url: "https://mail.example/m.json", created_at: "", last_opened_at: null, bounds: "" };
const tab: Tab = { id: "a", workspace_id: "w", tier: "today", url: app.start_url, title: "Inbox", favicon: null, position: 0, state: "active", last_active_at: "2026-09-10T00:00:00Z" };

let stateEvent: (payload: import("../lib/ipc").CoreEvent) => void;
const initialBrowser = useBrowser.getState();
beforeEach(() => {
  vi.clearAllMocks();
  useBrowser.setState({ ...initialBrowser, tabs: [tab], activeTab: tab.id }, true);
  usePrefs.setState({ load: vi.fn().mockResolvedValue(undefined) });
  useWebApps.setState({ uninstall: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(ipc.tabInfo).mockResolvedValue(tab);
  vi.mocked(ipc.popoutReady).mockResolvedValue(false);
  vi.mocked(ipc.webappForWindow).mockResolvedValue(app);
  vi.mocked(ipc.webappIcon).mockResolvedValue("data:image/png;base64,AAAA");
  vi.mocked(ipc.tabAttach).mockResolvedValue(null);
  vi.spyOn(ipc, "popoutSetBounds").mockResolvedValue(null);
  vi.spyOn(ipc, "tabHistory").mockResolvedValue({ generation: "g", current_index: 0, entries: [{ id: 1, url: tab.url, title: "Inbox" }] });
  vi.spyOn(events.tabHistoryChanged, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(events.tabLoad, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(events.menuCommand, "listen").mockResolvedValue(() => undefined);
  vi.spyOn(events.stateChanged, "listen").mockImplementation(async (callback) => {
    stateEvent = (payload) => callback({ event: "state-changed", id: 0, payload });
    return () => undefined;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AppWindow", () => {
  it("shows the app's name, no address bar, and no scope warning inside the app", async () => {
    render(<AppWindow tabId="a" appId={app.id} />);
    await screen.findByText("Mail by Example");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(ipc.popoutReady).toHaveBeenCalledWith("a"));
  });

  it("warns when the page leaves the app's scope and offers it as a normal tab", async () => {
    render(<AppWindow tabId="a" appId={app.id} />);
    await screen.findByText("Mail by Example");
    act(() => stateEvent({ type: "tab_upserted", data: { ...tab, url: "https://other.example/login" } }));
    const bar = await screen.findByRole("status");
    expect(bar.textContent).toContain("other.example");
    fireEvent.click(screen.getByRole("button", { name: "Open in Dive" }));
    await waitFor(() => expect(ipc.tabAttach).toHaveBeenCalledWith("a"));
  });

  it("uninstalls from the app menu", async () => {
    render(<AppWindow tabId="a" appId={app.id} />);
    await screen.findByText("Mail by Example");
    fireEvent.click(screen.getByRole("button", { name: "App menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Uninstall Mail" }));
    expect(useWebApps.getState().uninstall).toHaveBeenCalledWith(app.id);
  });
});
