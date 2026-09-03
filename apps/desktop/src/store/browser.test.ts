import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
import { reduceCrash, reduceEvent, reduceLoad, reduceWindowChange, useBrowser } from "./browser";
import type { CrashState, NavError } from "./browser";
import { events, ipc } from "../lib/ipc";
import type { Tab, TabCrashed, TabLoad } from "../lib/ipc";

const tab = (id: string, url = "https://x"): Tab => ({
  id, workspace_id: "w", tier: "today", url, title: "", position: 0, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null,
});

describe("reduceEvent", () => {
  it("upserts tabs in place", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: null, detached: [] };
    const out = reduceEvent(base, { type: "tab_upserted", data: tab("a", "https://y") });
    expect(out.tabs?.map((t) => t.url)).toEqual(["https://y", "https://x"]);
  });

  it("closing the active tab clears the selection until the engine activates a replacement", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "b", activeWorkspace: "w", recordingTab: null, detached: [] };
    const out = reduceEvent(base, { type: "tab_closed", data: "b" });
    expect(out).toEqual({ tabs: [tab("a")], activeTab: null, recordingTab: null, detached: [] });
    expect(reduceEvent({ ...base, ...out }, { type: "tab_activated", data: "a" })).toEqual({ activeTab: "a" });
  });

  it("closing the tab being recorded drops the recording state", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: "b", detached: [] };
    expect(reduceEvent(base, { type: "tab_closed", data: "b" }).recordingTab).toBeNull();
    expect(reduceEvent(base, { type: "tab_closed", data: "a" }).recordingTab).toBe("b");
  });
});

describe("reduceWindowChange", () => {
  it("blanks the main window when the tab it showed leaves for its own window", () => {
    expect(reduceWindowChange({ detached: [], activeTab: "a" }, "a", true)).toEqual({ detached: ["a"], activeTab: null });
    expect(reduceWindowChange({ detached: [], activeTab: "b" }, "a", true)).toEqual({ detached: ["a"], activeTab: "b" });
  });

  it("forgets a tab that came back", () => {
    expect(reduceWindowChange({ detached: ["a", "b"], activeTab: null }, "a", false)).toEqual({ detached: ["b"], activeTab: null });
  });
});

const load = (tab_id: string, phase: TabLoad["phase"], extra: Partial<TabLoad> = {}): TabLoad => ({ tab_id, phase, url: "https://x", error: null, ...extra });
const none: { loading: Record<string, boolean>; navError: Record<string, NavError>; crashedTabs: Record<string, CrashState> } = { loading: {}, navError: {}, crashedTabs: {} };

describe("reduceLoad", () => {
  it("tracks the main frame from started to stopped", () => {
    const started = { ...none, ...reduceLoad(none, load("a", "started")) };
    expect(started.loading).toEqual({ a: true });
    const stopped = { ...started, ...reduceLoad(started, load("a", "stopped")) };
    expect(stopped.loading).toEqual({});
  });

  it("keeps a failure through the stop that follows it, until the next start or navigation", () => {
    const failed = { ...none, ...reduceLoad(none, load("a", "failed", { error: "net::ERR_NAME_NOT_RESOLVED", url: "https://nope.test/" })) };
    expect(failed.navError).toEqual({ a: { url: "https://nope.test/", error: "net::ERR_NAME_NOT_RESOLVED" } });
    expect(failed.loading).toEqual({});
    const stopped = { ...failed, ...reduceLoad(failed, load("a", "stopped")) };
    expect(stopped.navError.a).toBeDefined();
    const restarted = { ...stopped, ...reduceLoad(stopped, load("a", "started")) };
    expect(restarted.navError).toEqual({});
  });

  it("clears the error when the user navigates the tab", async () => {
    vi.spyOn(ipc, "tabNavigate").mockResolvedValue(null);
    useBrowser.setState({ activeTab: "a", tabs: [tab("a")], navError: { a: { url: "https://x", error: "net::ERR_CONNECTION_REFUSED" } } });
    await useBrowser.getState().navigate("https://y");
    expect(useBrowser.getState().navError).toEqual({});
    expect(ipc.tabNavigate).toHaveBeenCalledWith("a", "https://y");
  });

  it("forgets a tab that closes", () => {
    useBrowser.setState({ tabs: [tab("a")], loading: { a: true }, navError: { a: { url: "", error: "x" } }, crashedTabs: { a: { attempt: 1, recovering: true } } });
    useBrowser.getState().applyEvent({ type: "tab_closed", data: "a" });
    const s = useBrowser.getState();
    expect([s.loading, s.navError, s.crashedTabs]).toEqual([{}, {}, {}]);
  });
});

describe("reduceCrash", () => {
  it("remembers the crash until the tab finishes loading again", () => {
    const crashed = { ...none, ...reduceCrash({ ...none, loading: { a: true } }, { tab_id: "a", attempt: 2, recovering: true }) };
    expect(crashed.crashedTabs).toEqual({ a: { attempt: 2, recovering: true } });
    expect(crashed.loading).toEqual({});
    const gaveUp = { ...crashed, ...reduceCrash(crashed, { tab_id: "a", attempt: 3, recovering: false }) };
    expect(gaveUp.crashedTabs.a).toEqual({ attempt: 3, recovering: false });
    const back = { ...gaveUp, ...reduceLoad(gaveUp, load("a", "stopped")) };
    expect(back.crashedTabs).toEqual({});
  });
});

describe("optimistic switching", () => {
  const initial = useBrowser.getState();
  afterEach(() => {
    useBrowser.setState(initial, true);
    vi.restoreAllMocks();
  });

  it("highlights the tab before the engine answers and keeps it when it agrees", async () => {
    let done!: () => void;
    vi.spyOn(ipc, "tabActivate").mockReturnValue(new Promise<null>((r) => (done = () => r(null))));
    useBrowser.setState({ tabs: [tab("a"), tab("b")], activeTab: "a" });
    const p = useBrowser.getState().activateTab("b");
    expect(useBrowser.getState().activeTab).toBe("b");
    done();
    await p;
    useBrowser.getState().applyEvent({ type: "tab_activated", data: "b" });
    expect(useBrowser.getState().activeTab).toBe("b");
    expect(useBrowser.getState().error).toBeNull();
  });

  it("rolls the tab back when the engine refuses", async () => {
    vi.spyOn(ipc, "tabActivate").mockRejectedValue(new Error("no such tab"));
    useBrowser.setState({ tabs: [tab("a"), tab("b")], activeTab: "a" });
    await useBrowser.getState().activateTab("b");
    expect(useBrowser.getState().activeTab).toBe("a");
    expect(useBrowser.getState().error).toBe("no such tab");
  });

  it("does not roll back over a selection that moved on in the meantime", async () => {
    vi.spyOn(ipc, "tabActivate").mockRejectedValue(new Error("gone"));
    useBrowser.setState({ tabs: [tab("a"), tab("b"), tab("c")], activeTab: "a" });
    const p = useBrowser.getState().activateTab("b");
    useBrowser.getState().applyEvent({ type: "tab_activated", data: "c" });
    await p;
    expect(useBrowser.getState().activeTab).toBe("c");
  });

  it("moves the rail at once and fills the tabs in from the snapshot", async () => {
    let done!: () => void;
    vi.spyOn(ipc, "workspaceActivate").mockReturnValue(new Promise<null>((r) => (done = () => r(null))));
    const snapshot = vi.spyOn(ipc, "snapshot").mockResolvedValue({ workspaces: [], active_workspace: "w2", tabs: [tab("z")], active_tab: "z", detached: [] });
    vi.spyOn(ipc, "workspaceTabCounts").mockResolvedValue([]);
    useBrowser.setState({ activeWorkspace: "w1", tabs: [tab("a")], activeTab: "a" });
    const p = useBrowser.getState().activateWorkspace("w2");
    expect(useBrowser.getState().activeWorkspace).toBe("w2");
    expect(snapshot).not.toHaveBeenCalled();
    done();
    await p;
    expect(useBrowser.getState().tabs.map((t) => t.id)).toEqual(["z"]);
    expect(useBrowser.getState().activeTab).toBe("z");
  });

  it("rolls the workspace back when the engine refuses, without a snapshot", async () => {
    vi.spyOn(ipc, "workspaceActivate").mockRejectedValue(new Error("unknown workspace"));
    const snapshot = vi.spyOn(ipc, "snapshot");
    useBrowser.setState({ activeWorkspace: "w1" });
    await useBrowser.getState().activateWorkspace("w2");
    expect(useBrowser.getState().activeWorkspace).toBe("w1");
    expect(useBrowser.getState().error).toBe("unknown workspace");
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe("boot", () => {
  it("subscribes to load and crash events once and feeds them into the store", async () => {
    const initial = useBrowser.getState();
    let onLoad!: (e: Event<TabLoad>) => void;
    let onCrash!: (e: Event<TabCrashed>) => void;
    const loadListen = vi.spyOn(events.tabLoad, "listen").mockImplementation(async (cb) => ((onLoad = cb), () => undefined));
    const crashListen = vi.spyOn(events.tabCrashed, "listen").mockImplementation(async (cb) => ((onCrash = cb), () => undefined));
    vi.spyOn(events.stateChanged, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(events.tabWindowChanged, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(events.downloadNotice, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(events.consoleEntry, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(events.networkEvent, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(ipc, "snapshot").mockResolvedValue({ workspaces: [], active_workspace: null, tabs: [], active_tab: null, detached: [] });
    vi.spyOn(ipc, "workspaceTabCounts").mockResolvedValue([]);

    await useBrowser.getState().boot();
    await useBrowser.getState().boot();
    expect(loadListen).toHaveBeenCalledTimes(1);
    expect(crashListen).toHaveBeenCalledTimes(1);

    onLoad({ event: "tab-load", id: 1, payload: load("a", "started") });
    expect(useBrowser.getState().loading).toEqual({ a: true });
    onCrash({ event: "tab-crashed", id: 2, payload: { tab_id: "a", attempt: 1, recovering: true } });
    expect(useBrowser.getState().crashedTabs).toEqual({ a: { attempt: 1, recovering: true } });

    useBrowser.setState(initial, true);
    vi.restoreAllMocks();
  });
});
