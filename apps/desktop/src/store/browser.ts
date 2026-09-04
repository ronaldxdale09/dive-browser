import { create } from "zustand";
import { ipc, events } from "../lib/ipc";
import { listenConsole, useConsole } from "./console";
import { listenNetwork, useNetwork } from "./network";
import { clearPrivacy, listenPrivacy, usePrivacy } from "./privacy";
import { useDownloads } from "./downloads";
import type { CoreEvent, Decision, Duration, PermissionAsked, Snapshot, Tab, TabCrashed, TabLoad, TabTier, Workspace, Profile, ProfileDraftInput } from "../lib/ipc";

export type UiPanel = "sidecar" | "dock" | "palette" | "find" | "settings" | "library" | "extensions" | "shortcuts" | "menu" | "defaultBrowser" | "subtitles";
/** The sections of the library dialog. */
export type LibraryTab = "bookmarks" | "history" | "downloads" | "recordings";

/** The panels of the settings dialog; `openSettings` can land on any of them. */
export type SettingsSection = "general" | "appearance" | "privacy" | "downloads" | "developer" | "agent" | "subtitles" | "shortcuts" | "about";

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
  detachTab: (id: string, at: { x: number; y: number } | null) => Promise<void>;
  attachTab: (id: string) => Promise<void>;
  open: Record<Exclude<UiPanel, "extensions">, boolean> & { extensions?: boolean };
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
  openSettings: (section?: SettingsSection) => void;
  boot: () => Promise<void>;
  openTab: (url: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  reload: () => Promise<void>;
  capture: (fullPage: boolean) => Promise<void>;
  /** A user capture is traversing/encoding; blocks duplicate requests. */
  capturing: boolean;
  /** Zoom factor per tab; absent means 1. */
  zoom: Record<string, number>;
  zoomStep: (direction: 1 | -1 | 0) => Promise<void>;
  devtools: () => Promise<void>;
  bugReport: () => Promise<void>;
  /** Tab whose screen is being recorded, if any. */
  recordingTab: string | null;
  screencastToggle: () => Promise<void>;
  notice: string | null;
  /** Path of the capture currently open in the annotator. */
  annotating: string | null;
  setAnnotating: (path: string | null) => void;
  reorderTabs: (ordered: string[]) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  activateWorkspace: (id: string) => Promise<void>;
  /** Live tab count per workspace id; the snapshot only carries the active one's tabs. */
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
  applyEvent: (event: CoreEvent) => void;
}

export type NavError = { url: string; error: string };
export type CrashState = { attempt: number; recovering: boolean };

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
      return { activeWorkspace: event.data, activeProfile: profile };
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
      return { activeTab: event.data };
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
  open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, extensions: false, shortcuts: false, menu: false, defaultBrowser: false, subtitles: false },
  libraryTab: "bookmarks",
  openLibrary: (libraryTab) => set((s) => ({ libraryTab, open: { ...s.open, library: true, menu: false } })),
  settingsSection: "general",
  openSettings: (section = "general") => set((s) => ({ settingsSection: section, open: { ...s.open, settings: true } })),
  permissionRequests: {},
  applyPermissionAsked: (asked) => set((s) => ({ permissionRequests: reducePermissionAsked(s.permissionRequests, asked) })),
  decidePermission: async (tabId, request, decision, duration) => {
    await ipc.permissionReply(tabId, request.request_id, decision, duration);
    set((s) => ({ permissionRequests: withoutRequest(s.permissionRequests, tabId, request) }));
  },
  counts: {},
  error: null,
  notice: null,
  annotating: null,
  capturing: false,
  zoom: {},
  loading: {},
  navError: {},
  crashedTabs: {},
  recordingTab: null,
  applyLoad: (load) => {
    if (load.phase === "started") clearPrivacy(load.tab_id);
    set((s) => reduceLoad(s, load));
  },
  applyCrash: (crash) => set((s) => reduceCrash(s, crash)),
  setAnnotating: (path) => set({ annotating: path }),
  editing: null,
  setEditing: (editing) => set({ editing }),

  boot: async () => {
    try {
      unlisten ??= await events.stateChanged.listen((e) => get().applyEvent(e.payload));
      unlistenLoad ??= await events.tabLoad.listen((e) => get().applyLoad(e.payload));
      unlistenCrash ??= await events.tabCrashed.listen((e) => get().applyCrash(e.payload));
      unlistenPermission ??= await events.permissionAsked.listen((e) => get().applyPermissionAsked(e.payload));
      unlistenPermissionDismissed ??= await events.permissionDismissed.listen((e) => set((s) => ({permissionRequests: withoutRequest(s.permissionRequests,e.payload.tab_id,e.payload)})));
      await events.tabWindowChanged.listen((e) => set(reduceWindowChange(get(), e.payload.tab, e.payload.detached)));
      await events.downloadNotice.listen((e) => {
        const d = e.payload;
        useDownloads.getState().apply(d);
        const name = d.path.split("/").pop() ?? d.url;
        set({ notice: d.status === "started" ? `Downloading ${name}` : d.status === "finished" ? `Saved ${name}` : `Download failed: ${name}` });
        setTimeout(() => set({ notice: null }), 5000);
      });
      await Promise.all([listenConsole(), listenNetwork(), listenPrivacy(), usePrivacy.getState().loadInfo()]);
      set({ ...fromSnapshot(await ipc.snapshot()), ready: true, error: null });
      void get().refreshCounts();
    } catch (e) {
      set({ error: String(e), ready: true });
    }
  },

  openTab: async (url) => {
    const ws = get().activeWorkspace;
    if (!ws) return;
    await run(set, () => ipc.tabOpen(ws, url));
  },
  detachTab: async (id, at) => run(set, () => ipc.tabDetach(id, at)),
  attachTab: async (id) => run(set, () => ipc.tabAttach(id)),
  closeTab: async (id) => {
    await run(set, () => ipc.tabClose(id));
    useConsole.getState().drop(id);
    useNetwork.getState().drop(id);
    usePrivacy.getState().drop(id);
  },
  activateTab: async (id) => {
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
      set((s) => ({ activeTab: s.activeTab === id ? prev : s.activeTab, error: message(e) }));
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
        error: message(e),
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
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  print: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabPrint(id));
  },
  setTier: async (id, tier) => run(set, () => ipc.tabSetTier(id, tier)),
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
      set({ notice: `Bug report copied · saved ${path.split("/").pop() ?? path}` });
      setTimeout(() => set({ notice: null }), 5000);
    });
  },
  devtools: async () => {
    const id = get().activeTab;
    if (id) await run(set, () => ipc.tabDevtools(id));
  },
  zoomStep: async (direction) => {
    const id = get().activeTab;
    if (!id) return;
    const current = get().zoom[id] ?? 1;
    const next = direction === 0 ? 1 : nextZoom(current, direction);
    if (next === current) return;
    await run(set, async () => {
      await ipc.tabZoom(id, next);
      set((s) => ({ zoom: { ...s.zoom, [id]: next } }));
    });
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
      set({ annotating: null, notice: `Captured ${path.split("/").pop() ?? path}` });
      setTimeout(() => set({ notice: null }), 4000);
    } catch (cause) {
      set({ error: message(cause) });
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
      set({ tabs: prevTabs, error: message(e) });
    }
  },
  setPinned: async (id, pinned) => run(set, () => ipc.tabSetPinned(id, pinned)),
  activateWorkspace: async (id) => {
    // The rail moves at once. The engine only announces `workspace_activated`
    // and the tab it focuses, never the workspace's tab list, so the snapshot
    // round trip stays; it just no longer gates the highlight.
    const prev = get().activeWorkspace;
    if (prev === id) return;
    set({ activeWorkspace: id });
    try {
      await ipc.workspaceActivate(id);
    } catch (e) {
      set((s) => ({ activeWorkspace: s.activeWorkspace === id ? prev : s.activeWorkspace, error: message(e) }));
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
      set({ workspaces: prevWorkspaces, error: message(e) });
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

  toggle: (panel, value) => set((s) => ({ open: { ...s.open, [panel]: value ?? !s.open[panel] } })),
  applyEvent: (event) => {
    set((s) => reduceEvent(s, event));
    if (event.type === "tab_closed") {
      const id = event.data;
      set((s) => ({ loading: without(s.loading, id), navError: without(s.navError, id), crashedTabs: without(s.crashedTabs, id), permissionRequests: without(s.permissionRequests, id) }));
      usePrivacy.getState().drop(id);
    }
    // Tabs of other workspaces never reach this store, so their badges come
    // from the host. Coalesced: a page load can emit several tab updates.
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

async function run(set: (p: Partial<BrowserState>) => void, f: () => Promise<unknown>) {
  try {
    await f();
    set({ error: null });
  } catch (e) {
    set({ error: message(e) });
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Zoom levels the chrome steps through; mirrors ZOOM_STEPS in commands.rs. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function nextZoom(current: number, direction: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((z) => Math.abs(z - current) < 0.001);
  const j = i === -1 ? ZOOM_STEPS.findIndex((z) => z > current) - (direction === 1 ? 0 : 1) : i + direction;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, j))] ?? 1;
}
