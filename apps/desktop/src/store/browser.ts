import { create } from "zustand";
import { ipc, events } from "../lib/ipc";
import { listenConsole, useConsole } from "./console";
import { listenNetwork, useNetwork } from "./network";
import { clearPrivacy, listenPrivacy, usePrivacy } from "./privacy";
import { useDownloads } from "./downloads";
import type { CoreEvent, Decision, Duration, NavigationHistory, PermissionAsked, Snapshot, Tab, TabCrashed, TabLoad, TabTier, Workspace, Profile, ProfileDraftInput } from "../lib/ipc";
import { errorMessage } from "../lib/errors";

export type UiPanel = "sidecar" | "dock" | "palette" | "find" | "settings" | "library" | "extensions" | "shortcuts" | "menu" | "defaultBrowser" | "subtitles" | "import";
/** The sections of the library dialog. */
export type LibraryTab = "bookmarks" | "history" | "downloads" | "recordings";

/** The panels of the settings dialog; `openSettings` can land on any of them. */
export type SettingsSection = "general" | "appearance" | "privacy" | "passwords" | "downloads" | "developer" | "agent" | "subtitles" | "shortcuts" | "about";

/** A page's outstanding request for a capability, awaiting the person's answer. */
export type PermissionRequest = PermissionAsked;

interface BrowserState {
  ready: boolean;
  workspaces: Workspace[];
  activeWorkspace: string | null;
  /** Every profile; the active one is the active workspace's. */
  profiles: Profile[];
  activeProfile: string | null;
  /** The profile dialog: `{ id: null }` creates, `{ id }` edits, `null` is closed. */
  editingProfile: { id: string | null } | null;
  setEditingProfile: (v: { id: string | null } | null) => void;
  createProfile: (draft: ProfileDraftInput) => Promise<void>;
  updateProfile: (id: string, draft: ProfileDraftInput) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  activateProfile: (id: string) => Promise<void>;
  tabs: Tab[];
  activeTab: string | null;
  /** Tabs living in their own window rather than the main one. */
  detached: string[];
  /** Tabs closed this session, oldest first; ⌘⇧T brings the last one back. */
  closedTabs: ClosedTab[];
  reopenClosedTab: () => Promise<void>;
  detachTab: (id: string, at: { x: number; y: number } | null) => Promise<void>;
  attachTab: (id: string) => Promise<void>;
  open: Record<Exclude<UiPanel, "extensions" | "import">, boolean> & { extensions?: boolean; import?: boolean };
  error: string | null;
  /** Tabs whose main frame is loading right now. */
  loading: Record<string, boolean>;
  /** Tabs whose last document request failed; cleared by the next load or navigation. */
  navError: Record<string, NavError>;
  /** Tabs whose renderer died; cleared once a load finishes. */
  crashedTabs: Record<string, CrashState>;
  applyLoad: (load: TabLoad) => void;
  applyCrash: (crash: TabCrashed) => void;
  /** Pages asking for a capability, per tab; one entry per native request. */
  permissionRequests: Record<string, PermissionRequest[]>;
  applyPermissionAsked: (asked: PermissionAsked) => void;
  /** Resolve the original native request, removing it only after success. */
  decidePermission: (tabId: string, request: PermissionRequest, decision: Decision, duration: Duration) => Promise<void>;
  /** Stop the active tab's load. */
  stop: () => Promise<void>;
  /** Open the print dialog for the active tab. */
  print: () => Promise<void>;
  /** Fill the tab with the page's video, or leave that state. */
  fillVideo: () => Promise<void>;
  setTier: (id: string, tier: TabTier) => Promise<void>;
  /** Which settings panel opens next; `openSettings` sets it and the dialog reads it once. */
  settingsSection: SettingsSection;
  /** A group id inside that panel to scroll to, read once by the dialog. */
  settingsAnchor: string | null;
  openSettings: (section?: SettingsSection, anchor?: string) => void;
  boot: () => Promise<void>;
  openTab: (url: string) => Promise<void>;
  /** Bring an open tab on `url`'s site to the front, or open one when there is none. */
  openOrSwitch: (url: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  /** A tab opened just to fetch a file has nothing to show once the download starts; close it. */
  closeIfOnlyDownload: (id: string, url: string) => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  /** Show the welcome screen; every tab stays open and comes back when clicked. */
  showHome: () => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  reload: () => Promise<void>;
  capture: (fullPage: boolean) => Promise<void>;
  /** A user capture is traversing/encoding; blocks duplicate requests. */
  capturing: boolean;
  /** Zoom factor per tab; absent means 1. */
  zoom: Record<string, number>;
  /** The zoom new tabs open at (the Default zoom preference), mirrored here so the badge and the steps agree with the engine. */
  defaultZoom: number;
  zoomStep: (direction: 1 | -1 | 0) => Promise<void>;
  /** The active tab's zoom as the engine has it: an explicit step, else the default new tabs open at. */
  zoomOf: (id: string | null) => number;
  devtools: () => Promise<void>;
  bugReport: () => Promise<void>;
  /** Tab whose screen is being recorded, if any. */
  recordingTab: string | null;
  screencastToggle: () => Promise<void>;
  notice: string | null;
  /** A button on the notice, when there is something to do about it ("Show in Finder"). */
  noticeAction: NoticeAction | null;
  /** Show a transient toast; a newer notice replaces the old one and its timer. */
  notify: (text: string, ms?: number, action?: NoticeAction) => void;
  reorderTabs: (ordered: string[]) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  activateWorkspace: (id: string) => Promise<void>;
  /** Open tab count including discarded tabs per workspace id; the snapshot only carries the active one's tabs. */
  counts: Record<string, number>;
  refreshCounts: () => Promise<void>;
  reorderWorkspaces: (ordered: string[]) => Promise<void>;
  createWorkspace: (draft: { name: string; color: string; icon: string }, separateContainer: boolean) => Promise<void>;
  updateWorkspace: (id: string, draft: { name: string; color: string; icon: string }) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  editing: { id: string | null } | null;
  setEditing: (v: { id: string | null } | null) => void;
  toggle: (panel: UiPanel, value?: boolean) => void;
  /** Which library section opens next; the dialog reads it once. */
  libraryTab: LibraryTab;
  openLibrary: (tab: LibraryTab) => void;
  /** What the palette leads with: everything, or the open tabs when it was opened to find one. */
  paletteFocus: "all" | "tabs";
  openPalette: (focus?: "all" | "tabs") => void;
  applyEvent: (event: CoreEvent) => void;
}

export type NavError = { url: string; error: string };
export type NoticeAction = { label: string; run: () => void };
export type ClosedTab = { url: string; title: string; workspace_id: string | null; index: number };
/** Most closed tabs remembered for reopening. */
export const CLOSED_TABS_LIMIT = 25;

/** The first tab already on `url`'s host, so a shortcut can switch instead of piling up duplicates. */
export function sameSiteTab(tabs: readonly Tab[], url: string): Tab | undefined {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return undefined;
  }
  return tabs.find((t) => {
    try {
      return new URL(t.url).host === host;
    } catch {
      return false;
    }
  });
}

/** Where `id` sits in its workspace's strip, for putting a reopened tab back. */
export function stripIndex(tabs: readonly Tab[], id: string): number {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return -1;
  return tabs.filter((t) => t.workspace_id === tab.workspace_id).findIndex((t) => t.id === id);
}

/** The order of a workspace's strip with `id` moved to `index`, for the engine to apply. */
export function orderWithAt(tabs: readonly Tab[], workspaceId: string, id: string, index: number): string[] {
  const ids = tabs.filter((t) => t.workspace_id === workspaceId && t.id !== id).map((t) => t.id);
  const at = Math.max(0, Math.min(index, ids.length));
  ids.splice(at, 0, id);
  return ids;
}

/** The closed-tab stack after `tab` went, or unchanged when there was nothing worth reopening. */
export function rememberClosed(stack: ClosedTab[], tab: Pick<Tab, "url" | "title" | "workspace_id"> | undefined, index = -1): ClosedTab[] {
  if (!tab || !tab.url || tab.url === "about:blank") return stack;
  const next = [...stack, { url: tab.url, title: tab.title, workspace_id: tab.workspace_id, index }];
  return next.length > CLOSED_TABS_LIMIT ? next.slice(next.length - CLOSED_TABS_LIMIT) : next;
}
export type CrashState = { attempt: number; recovering: boolean };

const NAVIGATION_DIALOGS = new Set<UiPanel>(["palette", "settings", "library", "shortcuts"]);

/**
 * Navigation dialogs replace each other; panels and editing workflows keep
 * their state. The main menu is a passing popover: whatever else opens
 * (find, the dock, a dialog) closes it, so a shortcut never leaves two
 * things fighting for the keyboard.
 */
export function togglePanel(open: BrowserState["open"], panel: UiPanel, value?: boolean): BrowserState["open"] {
  const shown = value ?? !open[panel];
  if (shown && NAVIGATION_DIALOGS.has(panel)) {
    return { ...open, palette: false, settings: false, library: false, shortcuts: false, menu: false, [panel]: true };
  }
  if (shown && panel !== "menu") return { ...open, menu: false, [panel]: shown };
  return { ...open, [panel]: shown };
}

type LoadState = Pick<BrowserState, "loading" | "navError" | "crashedTabs">;

/** Drop `key` from a record without mutating it; the same object when absent. */
function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  return Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
}

/**
 * Reduce a load-state change. A failed document request is followed by
 * `stopped`, so a stop never clears the error; only the next `started` (or
 * an explicit navigation) does. A stop does end crash recovery: the tab has
 * a document again.
 */
export function reduceLoad(state: LoadState, load: TabLoad): Partial<LoadState> {
  const id = load.tab_id;
  switch (load.phase) {
    case "started":
      return { loading: { ...state.loading, [id]: true }, navError: without(state.navError, id) };
    case "stopped":
      return { loading: without(state.loading, id), crashedTabs: without(state.crashedTabs, id) };
    case "failed":
      return { loading: without(state.loading, id), navError: { ...state.navError, [id]: { url: load.url ?? "", error: load.error ?? "" } } };
  }
}

/**
 * Queue a page's request. Chromium may ask again for the same thing while the
 * banner is up (a page that retries), so an opaque native request ID appears once.
 */
export function reducePermissionAsked(requests: Record<string, PermissionRequest[]>, asked: PermissionAsked): Record<string, PermissionRequest[]> {
  const list = requests[asked.tab_id] ?? [];
  if (list.some((r) => r.request_id === asked.request_id)) return requests;
  return { ...requests, [asked.tab_id]: [...list, asked] };
}

/** Drop one request; a tab with none left leaves the record. */
export function withoutRequest(requests: Record<string, PermissionRequest[]>, tabId: string, request: Pick<PermissionRequest, "request_id">): Record<string, PermissionRequest[]> {
  const rest = (requests[tabId] ?? []).filter((r) => r.request_id !== request.request_id);
  return rest.length === 0 ? without(requests, tabId) : { ...requests, [tabId]: rest };
}

export function reduceCrash(state: Pick<LoadState, "crashedTabs" | "loading">, crash: TabCrashed): Partial<LoadState> {
  return {
    crashedTabs: { ...state.crashedTabs, [crash.tab_id]: { attempt: crash.attempt, recovering: crash.recovering } },
    loading: without(state.loading, crash.tab_id),
  };
}

/** Reduce one core event into local state. Pure, so it is unit-testable. */
type Reduced = Pick<BrowserState, "workspaces" | "tabs" | "activeTab" | "activeWorkspace" | "recordingTab" | "detached" | "profiles" | "activeProfile">;

export function reduceEvent(state: Reduced, event: CoreEvent): Partial<Reduced> {
  switch (event.type) {
    case "workspace_upserted": {
      const others = state.workspaces.filter((w) => w.id !== event.data.id);
      return { workspaces: [...others, event.data].sort((a, b) => a.position - b.position) };
    }
    case "workspace_removed":
      return { workspaces: state.workspaces.filter((w) => w.id !== event.data) };
    case "workspace_activated": {
      const profile = state.workspaces.find((w) => w.id === event.data)?.profile_id ?? state.activeProfile;
      const tabs = state.tabs.filter((tab) => tab.workspace_id === event.data || tab.tier === "essential");
      const activeTab = tabs.some((tab) => tab.id === state.activeTab) ? state.activeTab : null;
      return { activeWorkspace: event.data, activeProfile: profile, tabs, activeTab };
    }
    case "profile_upserted": {
      const others = state.profiles.filter((p) => p.id !== event.data.id);
      return { profiles: [...others, event.data].sort((a, b) => a.position - b.position) };
    }
    case "profile_removed":
      return { profiles: state.profiles.filter((p) => p.id !== event.data) };
    case "profile_activated":
      return { activeProfile: event.data };
    case "tab_upserted": {
      // Events are global; mirror the active-workspace-plus-essentials snapshot.
      // Detached windows subscribe to their own page independently.
      if (event.data.workspace_id !== state.activeWorkspace && event.data.tier !== "essential") {
        if (!state.tabs.some((tab) => tab.id === event.data.id)) return {};
        return { tabs: state.tabs.filter((tab) => tab.id !== event.data.id), activeTab: state.activeTab === event.data.id ? null : state.activeTab };
      }
      const idx = state.tabs.findIndex((t) => t.id === event.data.id);
      const tabs = idx === -1 ? [...state.tabs, event.data] : state.tabs.map((t, i) => (i === idx ? event.data : t));
      return { tabs };
    }
    case "tab_closed": {
      // The engine picks the replacement and announces it with tab_activated.
      const tabs = state.tabs.filter((t) => t.id !== event.data);
      const activeTab = state.activeTab === event.data ? null : state.activeTab;
      // The engine discards that tab's recording; nothing is saved.
      const recordingTab = state.recordingTab === event.data ? null : state.recordingTab;
      const detached = state.detached.filter((id) => id !== event.data);
      return { tabs, activeTab, recordingTab, detached };
    }
    case "tab_activated":
      // Detachment arrives directly; an earlier queued activation can follow it.
      return state.detached.includes(event.data) ? {} : { activeTab: event.data };
    default:
      return {};
  }
}

function fromSnapshot(s: Snapshot) {
  return { workspaces: s.workspaces, activeWorkspace: s.active_workspace, tabs: s.tabs, activeTab: s.active_tab, detached: s.detached, profiles: s.profiles, activeProfile: s.active_profile };
}

/** A tab moved into its own window, or back. The main window's page goes
 * blank when the tab it was showing leaves; the engine does not announce a
 * replacement unless there is one. */
export function reduceWindowChange(state: Pick<BrowserState, "detached" | "activeTab">, tab: string, detached: boolean) {
  const rest = state.detached.filter((id) => id !== tab);
  return {
    detached: detached ? [...rest, tab] : rest,
    activeTab: detached && state.activeTab === tab ? null : state.activeTab,
  };
}

let unlisten: (() => void) | null = null;
let unlistenLoad: (() => void) | null = null;
let unlistenCrash: (() => void) | null = null;
let unlistenPermission: (() => void) | null = null;
let unlistenPermissionDismissed: (() => void) | null = null;
let unlistenWindowChanged: (() => void) | null = null;
let unlistenDownload: (() => void) | null = null;
/** The boot in flight, so a remount that boots again waits for it instead of subscribing twice. */
let booting: Promise<void> | null = null;
/** The one toast timer: a newer notice cancels the older one's clearing. */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
/** Zoom commands on their way to the engine, one per tab, and the level to send next. */
const zoomInFlight = new Map<string, Promise<void>>();
const zoomWanted = new Map<string, number>();
/** The workspace this chrome asked the engine for; its `workspace_activated` needs no refresh. */
let requestedWorkspace: string | null = null;

/**
 * True when the tab has no page of its own: nothing in its history, or only
 * a blank page or the download's own address. A page the person was reading
 * before clicking a download link stays open.
 */
export function tabHoldsOnly(history: NavigationHistory, url: string): boolean {
  const pages = history.entries.filter((entry) => entry.url !== "about:blank" && entry.url !== url);
  return pages.length === 0;
}

export const useBrowser = create<BrowserState>((set, get) => ({
  ready: false,
  workspaces: [],
  activeWorkspace: null,
  profiles: [],
  activeProfile: null,
  editingProfile: null,
  setEditingProfile: (editingProfile) => set({ editingProfile }),
  createProfile: async (draft) => {
    await run(set, () => ipc.profileCreate(draft));
    set({ ...fromSnapshot(await ipc.snapshot()), editingProfile: null });
    void get().refreshCounts();
  },
  updateProfile: async (id, draft) => {
    await run(set, () => ipc.profileUpdate(id, draft));
    set({ editingProfile: null });
  },
  deleteProfile: async (id) => {
    await run(set, () => ipc.profileDelete(id));
    set({ ...fromSnapshot(await ipc.snapshot()), editingProfile: null });
    void get().refreshCounts();
  },
  activateProfile: async (id) => {
    if (get().activeProfile === id) return;
    await run(set, () => ipc.profileActivate(id));
    set(fromSnapshot(await ipc.snapshot()));
    void get().refreshCounts();
  },
  tabs: [],
  activeTab: null,
  detached: [],
  closedTabs: [],
  reopenClosedTab: async () => {
    const last = get().closedTabs.at(-1);
    if (!last) {
      get().notify("No closed tab to reopen.");
      return;
    }
    set((s) => ({ closedTabs: s.closedTabs.slice(0, -1) }));
    if (last.workspace_id && last.workspace_id !== get().activeWorkspace && get().workspaces.some((w) => w.id === last.workspace_id)) {
      await get().activateWorkspace(last.workspace_id);
    }
    const ws = get().activeWorkspace;
    if (!ws) return;
    const opened = await run(set, () => ipc.tabOpen(ws, last.url));
    // Back where it was, not at the end of the strip.
    if (opened?.id && last.index >= 0 && last.workspace_id === ws) {
      const ordered = orderWithAt(get().tabs, ws, opened.id, last.index);
      if (ordered.includes(opened.id)) await ipc.tabReorder(ws, ordered).catch(() => undefined);
    }
  },
  open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, extensions: false, shortcuts: false, menu: false, defaultBrowser: false, subtitles: false },
  libraryTab: "bookmarks",
  openLibrary: (libraryTab) => set((s) => ({ libraryTab, open: togglePanel(s.open, "library", true) })),
  paletteFocus: "all",
  openPalette: (focus = "all") => set((s) => ({ paletteFocus: focus, open: togglePanel(s.open, "palette", true) })),
  settingsSection: "general",
  settingsAnchor: null,
  openSettings: (section = "general", anchor) => set((s) => ({ settingsSection: section, settingsAnchor: anchor ?? null, open: togglePanel(s.open, "settings", true) })),
  permissionRequests: {},
  applyPermissionAsked: (asked) => set((s) => ({ permissionRequests: reducePermissionAsked(s.permissionRequests, asked) })),
  decidePermission: async (tabId, request, decision, duration) => {
    await ipc.permissionReply(tabId, request.request_id, decision, duration);
    set((s) => ({ permissionRequests: withoutRequest(s.permissionRequests, tabId, request) }));
  },
  counts: {},
  error: null,
  notice: null,
  noticeAction: null,
  notify: (text, ms = 3000, action) => {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: text, noticeAction: action ?? null });
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      set({ notice: null, noticeAction: null });
    }, ms);
  },
  capturing: false,
  zoom: {},
  defaultZoom: 1,
  zoomOf: (id) => (id ? (get().zoom[id] ?? get().defaultZoom) : get().defaultZoom),
  loading: {},
  navError: {},
  crashedTabs: {},
  recordingTab: null,
  applyLoad: (load) => {
    if (load.phase === "started") {
      clearPrivacy(load.tab_id);
      useNetwork.getState().navigated(load.tab_id, load.url);
    }
    set((s) => reduceLoad(s, load));
  },
  applyCrash: (crash) => set((s) => reduceCrash(s, crash)),
  editing: null,
  setEditing: (editing) => set({ editing }),

  boot: () => {
    // A second boot while the first is still subscribing (StrictMode, an
    // error-boundary retry) would race past the `??=` guards below; share it.
    booting ??= (async () => {
      try {
        unlisten ??= await events.stateChanged.listen((e) => get().applyEvent(e.payload));
        unlistenLoad ??= await events.tabLoad.listen((e) => get().applyLoad(e.payload));
        unlistenCrash ??= await events.tabCrashed.listen((e) => get().applyCrash(e.payload));
        unlistenPermission ??= await events.permissionAsked.listen((e) => get().applyPermissionAsked(e.payload));
        unlistenPermissionDismissed ??= await events.permissionDismissed.listen((e) => set((s) => ({permissionRequests: withoutRequest(s.permissionRequests,e.payload.tab_id,e.payload)})));
        unlistenWindowChanged ??= await events.tabWindowChanged.listen((e) => set(reduceWindowChange(get(), e.payload.tab, e.payload.detached)));
        unlistenDownload ??= await events.downloadNotice.listen((e) => {
          const d = e.payload;
          useDownloads.getState().apply(d);
          const name = d.path.split("/").pop() ?? d.url;
          // A finished file is one click from the Finder; nothing to do about the others.
          const show = d.status === "finished" && d.path ? { label: "Show in Finder", run: () => void ipc.downloadsReveal(d.path).catch((err: unknown) => set({ error: errorMessage(err) })) } : undefined;
          get().notify(d.status === "started" ? `Downloading ${name}` : d.status === "finished" ? `Saved ${name}` : `Download failed: ${name}`, show ? 8000 : 5000, show);
          // Closed once the file is on disk, not when it starts: the engine
          // reports a download's end through the page it came from, so a
          // page closed mid-download never says "Saved".
          if (d.status !== "started" && d.tab) void get().closeIfOnlyDownload(d.tab, d.url);
        });
        await Promise.all([listenConsole(), listenNetwork(), listenPrivacy(), usePrivacy.getState().loadInfo()]);
        set({ ...fromSnapshot(await ipc.snapshot()), ready: true, error: null });
        void get().refreshCounts();
      } catch (e) {
        set({ error: String(e), ready: true });
      } finally {
        booting = null;
      }
    })();
    return booting;
  },

  openTab: async (url) => {
    const ws = get().activeWorkspace;
    if (!ws) return;
    await run(set, () => ipc.tabOpen(ws, url));
  },
  openOrSwitch: async (url) => {
    const existing = sameSiteTab(get().tabs, url);
    if (existing) return get().activateTab(existing.id);
    return get().openTab(url);
  },
  showHome: async () => {
    if (get().activeTab === null) return;
    await run(set, () => ipc.tabDeactivate());
    set({ activeTab: null });
  },
  detachTab: async (id, at) => {
    await run(set, () => ipc.tabDetach(id, at));
  },
  attachTab: async (id) => {
    await run(set, () => ipc.tabAttach(id));
  },
  closeIfOnlyDownload: async (id, url) => {
    let history: NavigationHistory | null = null;
    try {
      history = await ipc.tabHistory(id);
    } catch {
      return;
    }
    if (!tabHoldsOnly(history, url)) return;
    if (!get().tabs.some((t) => t.id === id)) return;
    await get().closeTab(id);
  },
  closeTab: async (id) => {
    await run(set, () => ipc.tabClose(id));
    useConsole.getState().drop(id);
    useNetwork.getState().drop(id);
    usePrivacy.getState().drop(id);
  },
  activateTab: async (id) => {
    if (get().detached.includes(id)) {
      await run(set, () => ipc.tabActivate(id));
      return;
    }
    // Optimistic: the strip highlights the tab at once and `tab_activated`
    // merely confirms. A refusal puts the selection back where it was, unless
    // something else moved it in the meantime.
    const prev = get().activeTab;
    if (prev === id) return;
    set({ activeTab: id });
    try {
      await ipc.tabActivate(id);
      set({ error: null });
    } catch (e) {
      set((s) => ({ activeTab: s.activeTab === id ? prev : s.activeTab, error: errorMessage(e) }));
    }
  },
  navigate: async (url) => {
    const id = get().activeTab;
    if (!id) return get().openTab(url);
    const prevTab = get().tabs.find((candidate) => candidate.id === id);
    const prevUrl = prevTab?.url;
    // Optimistic: show the destination immediately in the active tab;
    // if navigation rejects, roll back to the previous URL.
    set((s) => ({
      navError: without(s.navError, id),
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, url } : t)),
    }));
    try {
      await ipc.tabNavigate(id, url);
      set({ error: null });
    } catch (e) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, url: prevUrl ?? t.url } : t)),
        error: errorMessage(e),
      }));
    }
  },
  back: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabBack(id));
  },
  forward: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabForward(id));
  },
  reload: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabReload(id));
  },
  stop: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabStop(id));
  },
  fillVideo: async () => {
    const id = get().activeTab;
    if (!id) return;
    try {
      const outcome = await ipc.tabFillVideo(id);
      if (outcome === "no-video") set({ error: "No video on this page to fill the tab with." });
      else if (outcome === "unavailable") set({ error: "Fill tab is off for this page. Turn it on in Settings › General." });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },
  print: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabPrint(id));
  },
  setTier: async (id, tier) => {
    await run(set, () => ipc.tabSetTier(id, tier));
  },
  // The recorder lives in its own store; this stays for callers that only
  // know the browser store. `recordingTab` mirrors it for the strip and the
  // idle sweep.
  screencastToggle: async () => {
    const { useRecording } = await import("./recording");
    await useRecording.getState().toggle();
  },
  bugReport: async () => {
    const id = get().activeTab;
    if (!id) return;
    await run(set, async () => {
      const path = await ipc.tabBugReport(id);
      get().notify(`Bug report copied · saved ${path.split("/").pop() ?? path}`, 5000);
    });
  },
  devtools: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabDevtools(id));
  },
  zoomStep: async (direction) => {
    const id = get().activeTab;
    if (!id) return;
    const current = get().zoomOf(id);
    const next = direction === 0 ? get().defaultZoom : nextZoom(current, direction);
    if (next === current) return;
    // Shown at once so a held key or a double click steps twice, not once
    // from the same stale level; put back if the engine refuses.
    set((s) => ({ zoom: { ...s.zoom, [id]: next } }));
    // The engine applies zoom levels asynchronously, and two sent back to
    // back can settle out of order (the badge said 125% over a page at
    // 110%). One command is in flight per tab; a step that arrives
    // meanwhile only records the level wanted, sent once the first settles.
    zoomWanted.set(id, next);
    if (zoomInFlight.has(id)) return;
    const pump = async (): Promise<void> => {
      const wanted = zoomWanted.get(id);
      if (wanted === undefined) return;
      zoomWanted.delete(id);
      await run(set, async () => {
        try {
          await ipc.tabZoom(id, wanted);
        } catch (e) {
          set((s) => ({ zoom: { ...s.zoom, [id]: current } }));
          zoomWanted.delete(id);
          throw e;
        }
      });
      return pump();
    };
    const flight = pump().finally(() => zoomInFlight.delete(id));
    zoomInFlight.set(id, flight);
    await flight;
  },
  capture: async (fullPage) => {
    const id = get().activeTab;
    if (!id || get().capturing) return;
    const tab = get().tabs.find((candidate) => candidate.id === id);
    const workspace = get().activeWorkspace;
    set({ capturing: true, error: null });
    try {
      const path = await ipc.tabCapture(id, fullPage);
      const params = new URLSearchParams({ src: path });
      if (tab?.url) params.set("url", tab.url);
      if (tab?.title) params.set("title", tab.title);
      if (workspace) await ipc.tabOpen(workspace, `dive://capture?${params.toString()}`);
      get().notify(`Captured ${path.split("/").pop() ?? path}`, 4000);
    } catch (cause) {
      set({ error: errorMessage(cause) });
    } finally {
      set({ capturing: false });
    }
  },
  reorderTabs: async (ordered) => {
    const ws = get().activeWorkspace;
    if (!ws) return;
    const prevTabs = get().tabs;
    // Optimistic: renumber locally, the engine confirms with tab_upserted events.
    set((s) => ({ tabs: s.tabs.map((t) => (ordered.includes(t.id) ? { ...t, position: ordered.indexOf(t.id) } : t)) }));
    try {
      await ipc.tabReorder(ws, ordered);
      set({ error: null });
    } catch (e) {
      set({ tabs: prevTabs, error: errorMessage(e) });
    }
  },
  setPinned: async (id, pinned) => {
    await run(set, () => ipc.tabSetPinned(id, pinned));
  },
  activateWorkspace: async (id) => {
    // The rail moves at once. The engine only announces `workspace_activated`
    // and the tab it focuses, never the workspace's tab list, so the snapshot
    // round trip stays; it just no longer gates the highlight.
    const prev = get().activeWorkspace;
    if (prev === id) return;
    set({ activeWorkspace: id });
    requestedWorkspace = id;
    try {
      await ipc.workspaceActivate(id);
    } catch (e) {
      requestedWorkspace = null;
      set((s) => ({ activeWorkspace: s.activeWorkspace === id ? prev : s.activeWorkspace, error: errorMessage(e) }));
      return;
    }
    await run(set, async () => set(fromSnapshot(await ipc.snapshot())));
    void get().refreshCounts();
  },
  refreshCounts: async () => {
    try {
      const counts = await ipc.workspaceTabCounts();
      set({ counts: Object.fromEntries(counts.map((c) => [c.workspace_id, c.tabs])) });
    } catch {
      // A count is decoration; a failed read must not surface as an error.
    }
  },
  reorderWorkspaces: async (ordered) => {
    const prevWorkspaces = get().workspaces;
    // Optimistic, like tab reordering: the engine confirms with upsert events.
    set((s) => ({ workspaces: ordered.map((id) => s.workspaces.find((w) => w.id === id)).filter((w) => w !== undefined) }));
    try {
      await ipc.workspaceReorder(ordered);
      set({ error: null });
    } catch (e) {
      set({ workspaces: prevWorkspaces, error: errorMessage(e) });
    }
  },
  createWorkspace: async (draft, separateContainer) => {
    await run(set, () => ipc.workspaceCreate(draft, separateContainer));
    set({ ...fromSnapshot(await ipc.snapshot()), editing: null });
    void get().refreshCounts();
  },
  updateWorkspace: async (id, draft) => {
    await run(set, () => ipc.workspaceUpdate(id, draft));
    set({ editing: null });
  },
  deleteWorkspace: async (id) => {
    await run(set, () => ipc.workspaceDelete(id));
    set({ ...fromSnapshot(await ipc.snapshot()), editing: null });
    void get().refreshCounts();
  },

  toggle: (panel, value) => set((s) => ({ open: togglePanel(s.open, panel, value), ...(panel === "palette" ? { paletteFocus: "all" as const } : {}) })),
  applyEvent: (event) => {
    // Remembered before the reducer forgets the tab.
    const gone = event.type === "tab_closed" ? get().tabs.find((t) => t.id === event.data) : undefined;
    const goneIndex = event.type === "tab_closed" ? stripIndex(get().tabs, event.data) : -1;
    set((s) => reduceEvent(s, event));
    // A switch the engine made on its own (an automation call, a restore, a
    // link opened into another workspace) brings tabs this chrome has never
    // seen; only the snapshot has them. A switch this chrome asked for is
    // already fetching one.
    if (event.type === "workspace_activated") {
      const expected = requestedWorkspace === event.data;
      requestedWorkspace = null;
      if (!expected) {
        void run(set, async () => set(fromSnapshot(await ipc.snapshot())));
        void get().refreshCounts();
      }
    }
    if (event.type === "tab_closed") {
      const id = event.data;
      set((s) => ({ closedTabs: rememberClosed(s.closedTabs, gone, goneIndex) }));
      set((s) => ({ loading: without(s.loading, id), navError: without(s.navError, id), crashedTabs: without(s.crashedTabs, id), permissionRequests: without(s.permissionRequests, id) }));
      usePrivacy.getState().drop(id);
    }
    // Foreign-workspace tab events refresh badges without entering this strip.
    // Coalesced: a page load can emit several tab updates.
    if (event.type === "tab_upserted" || event.type === "tab_closed") scheduleCounts(get);
  },
}));

let countsTimer: ReturnType<typeof setTimeout> | null = null;

/** Ask for tab counts once the current burst of tab events has settled. */
function scheduleCounts(get: () => BrowserState) {
  if (countsTimer) clearTimeout(countsTimer);
  countsTimer = setTimeout(() => {
    countsTimer = null;
    void get().refreshCounts();
  }, 300);
}

async function run<T>(set: (p: Partial<BrowserState>) => void, f: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await f();
    set({ error: null });
    return result;
  } catch (e) {
    set({ error: errorMessage(e) });
    return undefined;
  }
}

/** Zoom levels the chrome steps through; mirrors ZOOM_STEPS in commands.rs. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function nextZoom(current: number, direction: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((z) => Math.abs(z - current) < 0.001);
  const j = i === -1 ? ZOOM_STEPS.findIndex((z) => z > current) - (direction === 1 ? 0 : 1) : i + direction;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, j))] ?? 1;
}
