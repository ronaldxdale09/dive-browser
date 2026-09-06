import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
import { reduceCrash, reduceEvent, reduceLoad, reducePermissionAsked, reduceWindowChange, useBrowser, withoutRequest } from "./browser";
import type { CrashState, NavError } from "./browser";
import { events, ipc } from "../lib/ipc";
import type { PermissionAsked, PermissionDismissed, Tab, TabCrashed, TabLoad, Workspace } from "../lib/ipc";
import { usePrivacy } from "./privacy";

const tab = (id: string, url = "https://x"): Tab => ({
  id, workspace_id: "w", tier: "today", url, title: "", position: 0, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null,
});

const ws = (id: string, name: string, position: number): Workspace => ({
  id, name, color: "#fff", icon: "home", container_id: "c1", profile_id: "p1", position, created_at: "2026-01-01T00:00:00Z",
});

describe("reduceEvent", () => {
  it("keeps background workspace updates out of the main tab strip while retaining essentials", () => {
    const base = { workspaces: [], tabs: [tab("a")], activeTab: "a", activeWorkspace: "w", recordingTab: null, detached: [], profiles: [], activeProfile: null };
    const foreign = { ...tab("background"), workspace_id: "other" };
    expect(reduceEvent(base, { type: "tab_upserted", data: foreign })).toEqual({});
    const essential = { ...foreign, tier: "essential" as const };
    expect(reduceEvent(base, { type: "tab_upserted", data: essential }).tabs).toEqual([tab("a"), essential]);
    const moved = { ...tab("a"), workspace_id: "other" };
    expect(reduceEvent(base, { type: "tab_upserted", data: moved })).toEqual({ tabs: [], activeTab: null });
  });

  it("replaces foreign strip entries before receiving the reattached workspace tabs", () => {
    const essential = { ...tab("essential"), tier: "essential" as const, workspace_id: null };
    const base = { workspaces: [ws("owner", "Home", 0)], tabs: [tab("foreign"), essential], activeTab: "foreign", activeWorkspace: "w", recordingTab: null, detached: ["returned"], profiles: [], activeProfile: "old" };
    const switched = { ...base, ...reduceEvent(base, { type: "workspace_activated", data: "owner" }) };
    expect(switched.tabs).toEqual([essential]);
    expect(switched.activeTab).toBeNull();
    expect(switched.activeProfile).toBe("p1");
    const returned = { ...tab("returned"), workspace_id: "owner" };
    const populated = { ...switched, ...reduceEvent(switched, { type: "tab_upserted", data: returned }) };
    expect(populated.tabs).toEqual([essential, returned]);
    const attached = { ...populated, ...reduceWindowChange(populated, returned.id, false) };
    expect(reduceEvent(attached, { type: "tab_activated", data: returned.id }).activeTab).toBe(returned.id);
  });

  it.each([null, "a"])("ignores a delayed activation of a detached page with main selection %s", (activeTab) => {
    const base = { workspaces: [], tabs: [tab("a")], activeTab, activeWorkspace: "w", recordingTab: null, detached: [], profiles: [], activeProfile: null };
    const detached = { ...base, ...reduceWindowChange(base, "b", true) };
    const upserted = { ...detached, ...reduceEvent(detached, { type: "tab_upserted", data: tab("b") }) };
    const late = { ...upserted, ...reduceEvent(upserted, { type: "tab_activated", data: "b" }) };
    expect(late.activeTab).toBe(activeTab);
    expect(late.detached).toEqual(["b"]);
  });

  it("upserts tabs in place", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: null, detached: [], profiles: [], activeProfile: null };
    const out = reduceEvent(base, { type: "tab_upserted", data: tab("a", "https://y") });
    expect(out.tabs?.map((t) => t.url)).toEqual(["https://y", "https://x"]);
  });

  it("closing the active tab clears the selection until the engine activates a replacement", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "b", activeWorkspace: "w", recordingTab: null, detached: [], profiles: [], activeProfile: null };
    const out = reduceEvent(base, { type: "tab_closed", data: "b" });
    expect(out).toEqual({ tabs: [tab("a")], activeTab: null, recordingTab: null, detached: [] });
    expect(reduceEvent({ ...base, ...out }, { type: "tab_activated", data: "a" })).toEqual({ activeTab: "a" });
  });

  it("closing the tab being recorded drops the recording state", () => {
    const base = { workspaces: [], tabs: [tab("a"), tab("b")], activeTab: "a", activeWorkspace: "w", recordingTab: "b", detached: [], profiles: [], activeProfile: null };
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

const request = (id: string, tab = "t1"): PermissionAsked => ({page_lifetime:true,request_id:id,tab_id:tab,origin:"https://a.test",kinds:["camera"],scope:{profile_id:"p1",container_id:"c1"}});
describe("permission helpers", () => {
  it("deduplicates event delivery by opaque native request, not origin", () => {
    const r1=reducePermissionAsked({},request("r1"));
    expect(reducePermissionAsked(r1,request("r1"))).toBe(r1);
    const r2=reducePermissionAsked(r1,request("r2"));
    expect(r2.t1).toHaveLength(2);
    expect(withoutRequest(r2,"t1",request("r1"))).toEqual({t1:[request("r2")]});
  });
  it("removes a single request and cleans up the empty tab list", () => {
    expect(withoutRequest({t1:[request("r1")]},"t1",request("r1"))).toEqual({});
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

  it("clears privacy results at the next main-frame start and drops them on close", () => {
    usePrivacy.getState().apply({ type: "blocked", data: { tab_id: "a", category: "ads" } });
    useBrowser.getState().applyLoad(load("a", "started"));
    expect(usePrivacy.getState().byTab.a).toBeUndefined();
    usePrivacy.getState().apply({ type: "blocked", data: { tab_id: "a", category: "ads" } });
    useBrowser.getState().applyEvent({ type: "tab_closed", data: "a" });
    expect(usePrivacy.getState().byTab.a).toBeUndefined();
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

  it("raises a detached page without changing the main selection", async () => {
    let finish!: () => void;
    vi.spyOn(ipc, "tabActivate").mockReturnValue(new Promise<null>((resolve) => { finish = () => resolve(null); }));
    useBrowser.setState({ tabs: [tab("a"), tab("b")], activeTab: "a", detached: ["b"] });
    const raised = useBrowser.getState().activateTab("b");
    expect(useBrowser.getState().activeTab).toBe("a");
    expect(ipc.tabActivate).toHaveBeenCalledWith("b");
    finish();
    await raised;
    expect(useBrowser.getState().activeTab).toBe("a");
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
    const snapshot = vi.spyOn(ipc, "snapshot").mockResolvedValue({ workspaces: [], active_workspace: "w2", tabs: [tab("z")], active_tab: "z", detached: [], profiles: [], active_profile: null });
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

  it("optimistically updates tab URL on navigate and rolls back if the engine refuses", async () => {
    vi.spyOn(ipc, "tabNavigate").mockRejectedValue(new Error("invalid protocol"));
    useBrowser.setState({ activeTab: "a", tabs: [tab("a", "https://prev.test")] });
    await useBrowser.getState().navigate("bad://protocol");
    expect(useBrowser.getState().tabs.find((t) => t.id === "a")?.url).toBe("https://prev.test");
    expect(useBrowser.getState().error).toBe("invalid protocol");
  });

  it("optimistically reorders tabs and rolls back if the engine refuses", async () => {
    vi.spyOn(ipc, "tabReorder").mockRejectedValue(new Error("reorder failed"));
    const t1 = { ...tab("t1"), position: 0 };
    const t2 = { ...tab("t2"), position: 1 };
    useBrowser.setState({ activeWorkspace: "w1", tabs: [t1, t2] });
    await useBrowser.getState().reorderTabs(["t2", "t1"]);
    expect(useBrowser.getState().tabs).toEqual([t1, t2]);
    expect(useBrowser.getState().error).toBe("reorder failed");
  });

  it("optimistically reorders workspaces and rolls back if the engine refuses", async () => {
    vi.spyOn(ipc, "workspaceReorder").mockRejectedValue(new Error("workspace reorder failed"));
    const w1 = ws("w1", "Work", 0);
    const w2 = ws("w2", "Personal", 1);
    useBrowser.setState({ workspaces: [w1, w2] });
    await useBrowser.getState().reorderWorkspaces(["w2", "w1"]);
    expect(useBrowser.getState().workspaces).toEqual([w1, w2]);
    expect(useBrowser.getState().error).toBe("workspace reorder failed");
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
    let onDismissed!: (e: Event<PermissionDismissed>) => void;
    vi.spyOn(events.permissionDismissed,"listen").mockImplementation(async(cb)=>((onDismissed=cb),()=>undefined));
    let onAsked!: (e: Event<PermissionAsked>) => void;
    const askedListen = vi.spyOn(events.permissionAsked, "listen").mockImplementation(async (cb) => ((onAsked = cb), () => undefined));
    const windowListen = vi.spyOn(events.tabWindowChanged, "listen").mockResolvedValue(() => undefined);
    const downloadListen = vi.spyOn(events.downloadNotice, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(events.consoleEntry, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(events.networkEvent, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(ipc, "snapshot").mockResolvedValue({ workspaces: [], active_workspace: null, tabs: [], active_tab: null, detached: [], profiles: [], active_profile: null });
    vi.spyOn(ipc, "workspaceTabCounts").mockResolvedValue([]);

    // Concurrent boots (StrictMode, a boundary retry) share one subscription pass.
    await Promise.all([useBrowser.getState().boot(), useBrowser.getState().boot()]);
    await useBrowser.getState().boot();
    expect(loadListen).toHaveBeenCalledTimes(1);
    expect(crashListen).toHaveBeenCalledTimes(1);
    expect(askedListen).toHaveBeenCalledTimes(1);
    expect(windowListen).toHaveBeenCalledTimes(1);
    expect(downloadListen).toHaveBeenCalledTimes(1);

    onAsked({ event: "permission-asked", id: 3, payload: request("r1","a") });
    expect(useBrowser.getState().permissionRequests).toEqual({ a: [request("r1","a")] });
    onDismissed({event:"permission-dismissed",id:4,payload:{request_id:"r1",tab_id:"a"}});
    expect(useBrowser.getState().permissionRequests).toEqual({});

    onLoad({ event: "tab-load", id: 1, payload: load("a", "started") });
    expect(useBrowser.getState().loading).toEqual({ a: true });
    onCrash({ event: "tab-crashed", id: 2, payload: { tab_id: "a", attempt: 1, recovering: true } });
    expect(useBrowser.getState().crashedTabs).toEqual({ a: { attempt: 1, recovering: true } });

    useBrowser.setState(initial, true);
    vi.restoreAllMocks();
  });
});

describe("fillVideo", () => {
  it("asks the engine to fill the active tab and explains when there is no video", async () => {
    const spy = vi.spyOn(ipc, "tabFillVideo").mockResolvedValue("no-video");
    useBrowser.setState({ activeTab: "t1", error: null });
    await useBrowser.getState().fillVideo();
    expect(spy).toHaveBeenCalledWith("t1");
    expect(useBrowser.getState().error).toMatch(/No video/);
    spy.mockResolvedValue("filled");
    useBrowser.setState({ error: null });
    await useBrowser.getState().fillVideo();
    expect(useBrowser.getState().error).toBeNull();
  });
});

describe("notify", () => {
  it("shows a notice, clears it after the delay, and lets a newer notice cancel the older timer", () => {
    vi.useFakeTimers();
    useBrowser.getState().notify("first", 1000);
    expect(useBrowser.getState().notice).toBe("first");
    vi.advanceTimersByTime(600);
    useBrowser.getState().notify("second", 1000);
    vi.advanceTimersByTime(600);
    // The first timer would have fired by now; it must not blank the second notice.
    expect(useBrowser.getState().notice).toBe("second");
    vi.advanceTimersByTime(400);
    expect(useBrowser.getState().notice).toBeNull();
    vi.useRealTimers();
  });

  it("defaults to three seconds", () => {
    vi.useFakeTimers();
    useBrowser.getState().notify("hello");
    vi.advanceTimersByTime(2999);
    expect(useBrowser.getState().notice).toBe("hello");
    vi.advanceTimersByTime(1);
    expect(useBrowser.getState().notice).toBeNull();
    vi.useRealTimers();
  });
});
