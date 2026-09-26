import { create } from "zustand";
import { showInFileManagerLabel } from "../lib/commands";
import { ipc, events } from "../lib/ipc";
import { listenConsole, useConsole, usesNativeConsoleBatch } from "./console";
import { listenNetwork, useNetwork } from "./network";
import { clearPrivacy, listenPrivacy, usePrivacy } from "./privacy";
import { useDownloads } from "./downloads";
import { useLayout } from "./layout";
import { canGoBack } from "../lib/useTabHistory";
import type { DownloadNotice, CoreEvent, Decision, Duration, NavigationHistory, PermissionAsked, Snapshot, Tab, TabCrashed, TabLoad, TabTier, Workspace, Profile, ProfileDraftInput } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { fileNameOr, fileUrl, opensInTab} from "../lib/paths";
import { isPrivateWindow } from "../lib/privateMode";
import { orderTabs } from "../lib/tabOrder";
import { uiStorage } from "../lib/uiStorage";
import { languageName, preferredLanguage, translationMessage } from "../lib/translate";

export type UiPanel = "sidecar" | "dock" | "palette" | "find" | "settings" | "library" | "extensions" | "shortcuts" | "menu" | "defaultBrowser" | "subtitles" | "tasks" | "import" | "apps";
/** The sections of the library dialog. */
export type LibraryTab = "bookmarks" | "history" | "downloads" | "recordings" | "apps";

/** The panels of the settings dialog; `openSettings` can land on any of them. */
export type SettingsSection = "general" | "appearance" | "privacy" | "passwords" | "wallet" | "downloads" | "developer" | "agent" | "subtitles" | "shortcuts" | "about";

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
  /**
   * The profile and workspace actions resolve to whether the engine did it.
   * The dialog stays open on a failure, with what was typed still in it.
   */
  createProfile: (draft: ProfileDraftInput) => Promise<boolean>;
  updateProfile: (id: string, draft: ProfileDraftInput) => Promise<boolean>;
  deleteProfile: (id: string) => Promise<boolean>;
  activateProfile: (id: string) => Promise<void>;
  tabs: Tab[];
  activeTab: string | null;
  /** Tabs living in their own window rather than the main one. */
  detached: string[];
  /** Tabs closed recently, oldest first, kept across restarts; ⌘⇧T brings the last one back. */
  closedTabs: ClosedTab[];
  /** Reopen the closed tab at `at` in `closedTabs`, the most recent when omitted. */
  reopenClosedTab: (at?: number) => Promise<void>;
  /** Close every unpinned tab in the workspace but `keep`, with an Undo that brings them back. */
  closeOtherTabs: (keep: string) => Promise<void>;
  detachTab: (id: string, at: { x: number; y: number } | null) => Promise<void>;
  attachTab: (id: string) => Promise<void>;
  open: Record<Exclude<UiPanel, "extensions" | "import" | "apps">, boolean> & { extensions?: boolean; import?: boolean; apps?: boolean };
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
  /** Float this tab's video over everything else, or bring it back. */
  pictureInPicture: () => Promise<void>;
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
  /**
   * Load what was typed in the active tab, resolving to whether the engine
   * took it. The tab's URL changes only when the engine commits the load.
   */
  navigate: (url: string) => Promise<boolean>;
  /** Show the welcome screen; every tab stays open and comes back when clicked. */
  showHome: () => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  /** Reload the active tab; `hard` skips the HTTP cache. */
  reload: (hard?: boolean) => Promise<void>;
  capture: (fullPage: boolean) => Promise<void>;
  /** Keep the active tab's page as a single file. */
  savePage: () => Promise<void>;
  /** Show just the article on the active tab, or put the page back. */
  readerView: () => Promise<void>;
  /** Translate the active tab into the browser's own language, or put it back when it already is. */
  translatePage: () => Promise<void>;
  /**
   * Reader view and translation per tab, as last seen. The address bar's
   * buttons and the palette's commands both read and write it, so either
   * shows what the other did. A navigation or a closed tab clears it.
   */
  pageModes: Record<string, PageMode>;
  setPageMode: (tabId: string, patch: Partial<PageMode>) => void;
  /** A user capture is traversing/encoding; blocks duplicate requests. */
  capturing: boolean;
  /** Zoom factor per tab; absent means the default new tabs open at. */
  zoom: Record<string, number>;
  /** The zoom new tabs open at (the Default zoom preference), mirrored here so the badge and the steps agree with the engine. */
  defaultZoom: number;
  /** Step the zoom of `tabId`, or of this window's active tab when none is named. */
  zoomStep: (direction: 1 | -1 | 0, tabId?: string) => Promise<void>;
  /** The engine applied this tab's zoom (site restore). Ignored while a step is in flight. */
  applyZoom: (id: string, factor: number) => void;
  /** The active tab's zoom as the engine has it: an explicit step, else the default new tabs open at. */
  zoomOf: (id: string | null) => number;
  devtools: () => Promise<void>;
  bugReport: () => Promise<void>;
  /** Tab whose screen is being recorded, if any. */
  recordingTab: string | null;
  screencastToggle: () => Promise<void>;
  notice: string | null;
  /** A button on the notice, when there is something to do about it ("Show in Finder" / Explorer). */
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
  createWorkspace: (draft: { name: string; color: string; icon: string }, separateContainer: boolean) => Promise<boolean>;
  updateWorkspace: (id: string, draft: { name: string; color: string; icon: string }) => Promise<boolean>;
  deleteWorkspace: (id: string) => Promise<boolean>;
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
/** What reader view and translation have done to a tab's page. */
export type PageMode = { reader: boolean; translated: string | null };
export type NoticeAction = { label: string; run: () => void };
export type ClosedTab = {
  url: string;
  title: string;
  workspace_id: string | null;
  index: number;
  scroll?: [number, number];
  /** Pinned or essential; a plain tab leaves it out. */
  tier?: TabTier;
};
/** Most closed tabs remembered for reopening. */
export const CLOSED_TABS_LIMIT = 25;
/** Scroll offsets of tabs the chrome is closing, keyed by tab id, until their tab_closed arrives. */
const scrollOfClosing = new Map<string, [number, number]>();

/**
 * Tabs this chrome asked the engine to close that are still open. A page is
 * asked before it goes (its "Leave site?" question), so a close takes a
 * moment, or never happens when the person stays. Until then a second ⌘W, a
 * held one or a double click must not ask the same page again: it moves on
 * to the neighbour instead.
 */
const closingTabs = new Map<string, ReturnType<typeof setTimeout> | null>();
/**
 * How long a close may go unanswered before the tab counts as open again.
 * A page with no question closes within a frame; one that asks keeps the
 * mark until the question is answered, which `pageAnsweredClose` hears.
 */
const CLOSE_PENDING_MS = 8000;

/** Whether this chrome has asked for `id` to close and is waiting for it to go. */
export function isClosing(id: string): boolean {
  return closingTabs.has(id);
}

function markClosing(id: string) {
  const previous = closingTabs.get(id);
  if (previous) clearTimeout(previous);
  closingTabs.set(id, setTimeout(() => closingTabs.delete(id), CLOSE_PENDING_MS));
}

function unmarkClosing(id: string) {
  const timer = closingTabs.get(id);
  if (timer) clearTimeout(timer);
  closingTabs.delete(id);
}

/**
 * The tab ⌘W should close: the active one, unless it is already closing, in
 * which case the next tab along that is not (then the one before). Holding
 * ⌘W walks the strip instead of asking one page over and over.
 */
export function nextCloseTarget(ordered: readonly string[], active: string | null, closing: (id: string) => boolean): string | null {
  if (active && !closing(active)) return active;
  const at = active ? ordered.indexOf(active) : -1;
  if (at === -1) return null;
  for (let i = at + 1; i < ordered.length; i++) if (!closing(ordered[i]!)) return ordered[i]!;
  for (let i = at - 1; i >= 0; i--) if (!closing(ordered[i]!)) return ordered[i]!;
  return null;
}

/**
 * A page being closed asked whether to leave. Its question is only shown
 * over its own page, so a tab closed from the strip while another was in
 * front comes forward to ask it.
 */
export function pagePromptedOnClose(tabId: string) {
  if (!closingTabs.has(tabId)) return;
  const { activeTab, detached, activateTab } = useBrowser.getState();
  // Keeps waiting for the answer, however long the person takes.
  const timer = closingTabs.get(tabId);
  if (timer) clearTimeout(timer);
  closingTabs.set(tabId, null);
  if (activeTab !== tabId && !detached.includes(tabId)) void activateTab(tabId);
}

/** The question was answered: staying keeps the tab, leaving closes it at once. */
export function pageAnsweredClose(tabId: string) {
  unmarkClosing(tabId);
}

/**
 * Per-tab state other stores keep (device emulation, audio), released when
 * the engine closes the tab. Those stores register here rather than being
 * imported by this one: they import this store, so that would be a cycle.
 */
const tabClosedHandlers = new Set<(tabId: string) => void>();

/** Run `handler` with the id of every tab the engine closes; returns the unsubscribe. */
export function onTabClosed(handler: (tabId: string) => void): () => void {
  tabClosedHandlers.add(handler);
  return () => tabClosedHandlers.delete(handler);
}

function forgetClosedTab(id: string) {
  for (const handler of tabClosedHandlers) {
    try {
      handler(id);
    } catch {
      // One store failing to let go must not keep the others holding on.
    }
  }
}

/**
 * The whole rail after part of it was reordered: the reordered workspaces
 * first, then every other one as it was, numbered the way the engine
 * numbers them. The rail only shows the active profile's workspaces, and
 * taking its order for the whole list dropped every other profile's.
 */
export function mergeWorkspaceOrder(all: readonly Workspace[], ordered: readonly string[]): Workspace[] {
  const listed = ordered.map((id) => all.find((w) => w.id === id)).filter((w) => w !== undefined);
  const rest = all.filter((w) => !ordered.includes(w.id));
  return [...listed, ...rest].map((w, position) => (w.position === position ? w : { ...w, position }));
}

/**
 * What each workspace's strip last showed, so switching back draws its tabs
 * and address at once instead of a blank strip until the engine's snapshot
 * arrives. The snapshot still replaces it a moment later.
 */
type WorkspaceView = { tabs: Tab[]; activeTab: string | null };
const workspaceViews = new Map<string, WorkspaceView>();

/** Forget every remembered strip; for tests. */
export function forgetWorkspaceViews() {
  workspaceViews.clear();
}

/** The strip to show for `workspace` right away: its remembered tabs beside the essentials in view now. */
export function cachedStrip(view: WorkspaceView | undefined, current: readonly Tab[], detached: readonly string[]): WorkspaceView | null {
  if (!view) return null;
  const essentials = current.filter((t) => t.tier === "essential");
  const tabs = [...essentials, ...view.tabs.filter((t) => t.tier !== "essential")];
  const activeTab = view.activeTab && tabs.some((t) => t.id === view.activeTab) && !detached.includes(view.activeTab) ? view.activeTab : null;
  return { tabs, activeTab };
}

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

/**
 * A workspace's strip in the order it is drawn: pinned first, then by
 * position. The store's array keeps the order tabs arrived in, which a drag
 * never changes -- only their positions -- so it cannot stand in for the strip.
 */
function stripOf(tabs: readonly Tab[], workspaceId: string | null): Tab[] {
  return orderTabs([...tabs]).filter((t) => t.workspace_id === workspaceId);
}

/** Where `id` sits in its workspace's strip, for putting a reopened tab back. */
export function stripIndex(tabs: readonly Tab[], id: string): number {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return -1;
  return stripOf(tabs, tab.workspace_id).findIndex((t) => t.id === id);
}

/** The order of a workspace's strip with `id` moved to `index`, for the engine to apply. */
export function orderWithAt(tabs: readonly Tab[], workspaceId: string, id: string, index: number): string[] {
  const ids = stripOf(tabs, workspaceId).filter((t) => t.id !== id).map((t) => t.id);
  const at = Math.max(0, Math.min(index, ids.length));
  ids.splice(at, 0, id);
  return ids;
}

/** The closed-tab stack after `tab` went, or unchanged when there was nothing worth reopening. */
export function rememberClosed(stack: ClosedTab[], tab: Pick<Tab, "url" | "title" | "workspace_id"> & { tier?: TabTier } | undefined, index = -1, scroll?: [number, number]): ClosedTab[] {
  if (!tab || !tab.url || tab.url === "about:blank") return stack;
  const entry: ClosedTab = { url: tab.url, title: tab.title, workspace_id: tab.workspace_id, index };
  if (scroll && (scroll[0] !== 0 || scroll[1] !== 0)) entry.scroll = scroll;
  if (tab.tier && tab.tier !== "today") entry.tier = tab.tier;
  const next = [...stack, entry];
  return next.length > CLOSED_TABS_LIMIT ? next.slice(next.length - CLOSED_TABS_LIMIT) : next;
}
export type CrashState = { attempt: number; recovering: boolean };

/** Where the closed-tab stack is kept between runs (the profile store, through `uiStorage`). */
const CLOSED_TABS_KEY = "closed-tabs";

/**
 * Only the main window of a normal session keeps the stack: every window's
 * chrome hears the same closes, and a private session keeps nothing.
 */
function keepsClosedTabs(): boolean {
  if (isPrivateWindow() || typeof window === "undefined") return false;
  const query = new URLSearchParams(window.location.search);
  return !query.get("popout") && !query.get("app");
}

/** The stack as it was last saved, dropping anything that does not read as one. */
export function parseClosedTabs(raw: string | null): ClosedTab[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is ClosedTab => typeof entry === "object" && entry !== null && typeof (entry as ClosedTab).url === "string" && typeof (entry as ClosedTab).title === "string" && typeof (entry as ClosedTab).index === "number")
      .slice(-CLOSED_TABS_LIMIT);
  } catch {
    return [];
  }
}

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
    case "tabs_reordered": {
      // The whole order of one workspace; each tab's position is its index.
      const order = new Map(event.data.ids.map((id, index) => [id, index]));
      if (!state.tabs.some((t) => order.has(t.id) && order.get(t.id) !== t.position)) return {};
      return { tabs: state.tabs.map((t) => (order.has(t.id) && order.get(t.id) !== t.position ? { ...t, position: order.get(t.id) ?? t.position } : t)) };
    }
    case "tab_closed": {
      // The engine picks the replacement and announces it with tab_activated.
      const tabs = state.tabs.filter((t) => t.id !== event.data);
      const activeTab = state.activeTab === event.data ? null : state.activeTab;
      // The engine saves that tab's recording; the strip has no tab to mark.
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

/** The active tab if it still lives in this window. A torn-off tab is the other window's dock. */
export function tabInThisWindow(activeTab: string | null, detached: readonly string[]): string | null {
  return activeTab && !detached.includes(activeTab) ? activeTab : null;
}

let unlisten: (() => void) | null = null;
let unlistenLoad: (() => void) | null = null;
let unlistenCrash: (() => void) | null = null;
let unlistenPermission: (() => void) | null = null;
let unlistenPermissionDismissed: (() => void) | null = null;
let unlistenWindowChanged: (() => void) | null = null;
let unlistenDownload: (() => void) | null = null;
let unlistenDownloadProgress: (() => void) | null = null;
let unlistenZoom: (() => void) | null = null;
/** The boot in flight, so a remount that boots again waits for it instead of subscribing twice. */
let booting: Promise<void> | null = null;
/** The saved closed-tab stack was read and is being written back; once per chrome. */
let closedTabsKept = false;
/** The one toast timer: a newer notice cancels the older one's clearing. */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
/** Zoom commands on their way to the engine, one per tab, and the level to send next. */
const zoomInFlight = new Map<string, Promise<void>>();
const zoomWanted = new Map<string, number>();
/** The workspace this chrome asked the engine for; its `workspace_activated` needs no refresh. */
let requestedWorkspace: string | null = null;
/**
 * Snapshots are asynchronous full-state reads. Events and user intent can move
 * the store on while a read is in flight, so only the newest request made
 * against an unchanged revision may commit.
 */
let intentRevision = 0;
let snapshotSequence = 0;
let eventRevision = 0;
type SnapshotDelta =
  | { revision: number; kind: "event"; event: CoreEvent }
  | { revision: number; kind: "window"; tab: string; detached: boolean };
type SnapshotDeltaInput =
  | { kind: "event"; event: CoreEvent }
  | { kind: "window"; tab: string; detached: boolean };
let snapshotDeltas: SnapshotDelta[] = [];
const SNAPSHOT_DELTA_LIMIT = 1024;
/** Snapshot reads waiting on the engine. Deltas are only worth keeping while there is one. */
let snapshotsInFlight = 0;
/** Bumped when the replay log overflows, so a read that lost its replay base retries. */
let deltaEpoch = 0;

function supersedeSnapshots() {
  intentRevision += 1;
  return intentRevision;
}

function recordSnapshotDelta(delta: SnapshotDeltaInput) {
  // With no read in flight nothing can replay this: the next read is taken
  // after it and already reflects it. Recording anyway filled the log with
  // every event of an idle session.
  if (snapshotsInFlight === 0) return;
  if (snapshotDeltas.length >= SNAPSHOT_DELTA_LIMIT) {
    // Bound replay memory. An in-flight snapshot that lost its replay base
    // must retry. That is not new intent, so it must not supersede a
    // workspace or profile being created, whose dialog closes on commit.
    deltaEpoch += 1;
    snapshotDeltas = [];
  }
  snapshotDeltas.push({ ...delta, revision: ++eventRevision } as SnapshotDelta);
}

async function snapshotCandidate() {
  const sequence = ++snapshotSequence;
  const intent = intentRevision;
  const events = eventRevision;
  const epoch = deltaEpoch;
  snapshotsInFlight += 1;
  let snapshot: Snapshot;
  try {
    snapshot = await ipc.snapshot();
  } catch (e) {
    // The last read failed and none will replay what was recorded for it.
    if (--snapshotsInFlight === 0) snapshotDeltas = [];
    throw e;
  }
  snapshotsInFlight -= 1;
  return {
    snapshot,
    intent,
    events,
    isLatest: () => sequence === snapshotSequence,
    isCurrent: () => sequence === snapshotSequence && intent === intentRevision && epoch === deltaEpoch,
  };
}

function replaySnapshot(snapshot: Snapshot, after: number): Partial<BrowserState> {
  const base = fromSnapshot(snapshot);
  // The counts that come with a snapshot already include these tabs.
  for (const tab of snapshot.tabs) tabWorkspaces.set(tab.id, tab.workspace_id);
  let state: Reduced = { ...base, recordingTab: null };
  for (const delta of snapshotDeltas) {
    if (delta.revision <= after) continue;
    if (delta.kind === "event") state = { ...state, ...reduceEvent(state, delta.event) };
    else state = { ...state, ...reduceWindowChange(state, delta.tab, delta.detached) };
  }
  const replayed: Partial<BrowserState> = { ...state };
  delete replayed.recordingTab;
  return replayed;
}

async function applyLatestSnapshot(set: (patch: Partial<BrowserState>) => void, extra: Partial<BrowserState> = {}, extraIntent = intentRevision): Promise<boolean> {
  for (;;) {
    const candidate = await snapshotCandidate();
    if (candidate.isCurrent()) {
      set({ ...replaySnapshot(candidate.snapshot, candidate.events), ...(extraIntent === intentRevision ? extra : {}) });
      snapshotDeltas = [];
      return true;
    }
    if (!candidate.isLatest()) return false;
  }
  return false;
}

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
  setEditingProfile: (editingProfile) => {
    supersedeSnapshots();
    set({ editingProfile });
  },
  // Each closes its dialog only once the engine has done it: closing on a
  // failure too threw away what had been typed, with the error somewhere else.
  createProfile: async (draft) => {
    const intent = supersedeSnapshots();
    if (!(await succeeded(set, () => ipc.profileCreate(draft)))) return false;
    await applyLatestSnapshot(set, { editingProfile: null }, intent);
    void get().refreshCounts();
    return true;
  },
  updateProfile: async (id, draft) => {
    const intent = supersedeSnapshots();
    if (!(await succeeded(set, () => ipc.profileUpdate(id, draft)))) return false;
    if (intent === intentRevision) set({ editingProfile: null });
    return true;
  },
  deleteProfile: async (id) => {
    const intent = supersedeSnapshots();
    if (!(await succeeded(set, () => ipc.profileDelete(id)))) return false;
    await applyLatestSnapshot(set, { editingProfile: null }, intent);
    void get().refreshCounts();
    return true;
  },
  activateProfile: async (id) => {
    if (get().activeProfile === id) return;
    supersedeSnapshots();
    await run(set, () => ipc.profileActivate(id));
    await applyLatestSnapshot(set);
    void get().refreshCounts();
  },
  tabs: [],
  activeTab: null,
  detached: [],
  closedTabs: [],
  reopenClosedTab: async (at) => {
    const stack = get().closedTabs;
    const position = at ?? stack.length - 1;
    const last = stack[position];
    if (!last) {
      get().notify("No closed tab to reopen.");
      return;
    }
    set((s) => ({ closedTabs: s.closedTabs.filter((entry) => entry !== last) }));
    if (last.workspace_id && last.workspace_id !== get().activeWorkspace && get().workspaces.some((w) => w.id === last.workspace_id)) {
      await get().activateWorkspace(last.workspace_id);
    }
    const ws = get().activeWorkspace;
    if (!ws) return;
    const opened = await run(set, () => ipc.tabOpen(ws, last.url));
    // Pinned or essential again, as it was.
    if (opened?.id && last.tier) await ipc.tabSetTier(opened.id, last.tier).catch(() => undefined);
    // Scrolled to where it was, once the page is back.
    if (opened?.id && last.scroll) await ipc.tabRestoreScroll(opened.id, last.scroll[0], last.scroll[1]).catch(() => undefined);
    // Back where it was, not at the end of the strip.
    if (opened?.id && last.index >= 0 && last.workspace_id === ws) {
      const ordered = orderWithAt(get().tabs, ws, opened.id, last.index);
      if (ordered.includes(opened.id)) await ipc.tabReorder(ws, ordered).catch(() => undefined);
    }
  },
  open: { sidecar: false, dock: false, palette: false, find: false, settings: false, library: false, extensions: false, shortcuts: false, menu: false, defaultBrowser: false, subtitles: false, tasks: false },
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
      // A new document is neither in reader view nor translated.
      if (get().pageModes[load.tab_id]) set((s) => ({ pageModes: without(s.pageModes, load.tab_id) }));
      clearPrivacy(load.tab_id);
      useNetwork.getState().navigated(load.tab_id, load.url);
      if (!usesNativeConsoleBatch()) useConsole.getState().navigated(load.tab_id);
    }
    set((s) => reduceLoad(s, load));
  },
  applyCrash: (crash) => set((s) => reduceCrash(s, crash)),
  editing: null,
  setEditing: (editing) => {
    supersedeSnapshots();
    set({ editing });
  },

  boot: () => {
    // A second boot while the first is still subscribing (StrictMode, an
    // error-boundary retry) would race past the `??=` guards below; share it.
    booting ??= (async () => {
      try {
        // Subscribed together, not one after another: each `listen` is its own
        // IPC round trip, and the content area waits on `ready` behind all of
        // them. The snapshot is applied after they resolve, so no event that
        // arrives in between is lost.
        const downloadNotice = (e: { payload: DownloadNotice }) => {
          const d = e.payload;
          useDownloads.getState().apply(d);
          const name = fileNameOr(d.path, d.url);
          // A finished file is one click from the Finder; nothing to do about
          // the others. A PDF is one click from being read instead, which is
          // what was wanted from it -- the browser renders it, so it opens in
          // a tab rather than in a document app.
          const finished = d.status === "finished" && d.path;
          const show = finished
            ? opensInTab(d.path)
              ? { label: "Open", run: () => void get().openTab(fileUrl(d.path)) }
              : { label: showInFileManagerLabel(), run: () => void ipc.downloadsReveal(d.path).catch((err: unknown) => set({ error: errorMessage(err) })) }
            : undefined;
          get().notify(
            d.status === "started" ? `Downloading ${name}` : d.status === "finished" ? `Saved ${name}` : d.status === "cancelled" ? `Download cancelled: ${name}` : `Download failed: ${name}`,
            show ? 8000 : 5000,
            show,
          );
          // Closed once the file is on disk, not when it starts: the engine
          // reports a download's end through the page it came from, so a
          // page closed mid-download never says "Saved".
          if (d.status !== "started" && d.tab) void get().closeIfOnlyDownload(d.tab, d.url);
        };
        // Each records its own unlisten the moment it resolves, rather than
        // all of them together at the end. Together, one rejection threw away
        // seven subscriptions that had already been made -- and the retry then
        // subscribed the survivors a second time.
        const once = async (
          held: (() => void) | null,
          subscribe: () => Promise<() => void>,
          keep: (off: () => void) => void,
        ) => {
          if (held) return;
          keep(await subscribe());
        };
        await Promise.all([
          once(unlisten, () => events.stateChanged.listen((e) => get().applyEvent(e.payload)), (off) => { unlisten = off; }),
          once(unlistenLoad, () => events.tabLoad.listen((e) => get().applyLoad(e.payload)), (off) => { unlistenLoad = off; }),
          once(unlistenCrash, () => events.tabCrashed.listen((e) => get().applyCrash(e.payload)), (off) => { unlistenCrash = off; }),
          once(unlistenPermission, () => events.permissionAsked.listen((e) => get().applyPermissionAsked(e.payload)), (off) => { unlistenPermission = off; }),
          once(unlistenPermissionDismissed, () => events.permissionDismissed.listen((e) => set((s) => ({permissionRequests: withoutRequest(s.permissionRequests,e.payload.tab_id,e.payload)}))), (off) => { unlistenPermissionDismissed = off; }),
          once(unlistenWindowChanged, () => events.tabWindowChanged.listen((e) => {
            recordSnapshotDelta({ kind: "window", tab: e.payload.tab, detached: e.payload.detached });
            set(reduceWindowChange(get(), e.payload.tab, e.payload.detached));
            // A torn-off tab is the other window's page; its split here
            // would wait on a pane that is not coming back.
            if (e.payload.detached) useLayout.getState().forget(e.payload.tab);
          }), (off) => { unlistenWindowChanged = off; }),
          once(unlistenDownload, () => events.downloadNotice.listen(downloadNotice), (off) => { unlistenDownload = off; }),
          once(unlistenDownloadProgress, () => events.downloadProgress.listen((e) => useDownloads.getState().progress(e.payload)), (off) => { unlistenDownloadProgress = off; }),
          once(unlistenZoom, () => events.tabZoom.listen((e) => {
            if (e.payload.factor == null) return;
            get().applyZoom(e.payload.tab_id, e.payload.factor);
          }), (off) => { unlistenZoom = off; }),
        ]);
        // The tabs closed in the last session can still come back.
        if (keepsClosedTabs() && !closedTabsKept) {
          closedTabsKept = true;
          set((s) => ({ closedTabs: [...parseClosedTabs(uiStorage.getItem(CLOSED_TABS_KEY)), ...s.closedTabs].slice(-CLOSED_TABS_LIMIT) }));
          useBrowser.subscribe((s, prev) => {
            if (s.closedTabs !== prev.closedTabs) uiStorage.setItem(CLOSED_TABS_KEY, JSON.stringify(s.closedTabs));
          });
        }
        const [, , , candidate] = await Promise.all([listenConsole(), listenNetwork(), listenPrivacy(), snapshotCandidate(), usePrivacy.getState().loadInfo()]);
        if (candidate.isCurrent()) {
          set(replaySnapshot(candidate.snapshot, candidate.events));
          snapshotDeltas = [];
        } else await applyLatestSnapshot(set);
        set({ ready: true, error: null });
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
    supersedeSnapshots();
    await run(set, () => ipc.tabDetach(id, at));
  },
  attachTab: async (id) => {
    supersedeSnapshots();
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
  closeOtherTabs: async (keep) => {
    const kept = get().tabs.find((t) => t.id === keep);
    const others = get().tabs.filter((t) => t.id !== keep && t.tier !== "pinned" && t.tier !== "essential" && (!kept || t.workspace_id === kept.workspace_id));
    if (others.length === 0) return;
    // One at a time, so the closed-tab stack keeps their order and Undo puts them back the same way.
    for (const t of others) await get().closeTab(t.id);
    const n = others.length;
    get().notify(`Closed ${n} ${n === 1 ? "tab" : "tabs"}`, 10000, {
      label: "Undo",
      run: () => {
        void (async () => {
          for (let i = 0; i < n; i++) await get().reopenClosedTab();
        })();
      },
    });
  },
  closeTab: async (id) => {
    if (closingTabs.has(id)) return;
    markClosing(id);
    // Where the page was scrolled, so reopening it lands in the same place.
    // Asked before the close; the answer is picked up by the tab_closed event.
    const scroll = await ipc.tabScrollPosition(id).catch(() => null);
    if (scroll) scrollOfClosing.set(id, scroll);
    const asked = await succeeded(set, () => ipc.tabClose(id));
    if (!asked) unmarkClosing(id);
    // Its console, requests and counts go with the tab_closed event, which
    // also covers tabs closed by the engine, an agent or a popout.
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
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (!id) {
      await get().openTab(url);
      return true;
    }
    // The tab keeps the address it has until the engine commits a new one.
    // Writing the raw text in here at once left it standing whenever the
    // load never committed -- a download, another app's link, a stop -- as
    // the engine does not republish an address that did not change. The
    // address bar shows what was typed meanwhile, and only there.
    set((s) => ({ navError: without(s.navError, id) }));
    try {
      await ipc.tabNavigate(id, url);
      set({ error: null });
      return true;
    } catch (e) {
      set({ error: errorMessage(e) });
      return false;
    }
  },
  back: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (!id) return;
    // ⌘[ on a brand-new tab would go back to the blank page its view was
    // created on; the button is disabled there, and so is the chord.
    const history = await ipc.tabHistory(id).catch(() => null);
    if (history && !canGoBack(history)) return;
    await run(set, () => ipc.tabBack(id));
  },
  forward: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (id) await run(set, () => ipc.tabForward(id));
  },
  reload: async (hard = false) => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (id) await run(set, () => (hard ? ipc.tabReloadHard(id) : ipc.tabReload(id)));
  },
  stop: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (id) await run(set, () => ipc.tabStop(id));
  },
  fillVideo: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
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
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (id) await run(set, () => ipc.tabPrint(id));
  },
  pictureInPicture: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (!id) return;
    // The outcome is worth saying: "no video on this page to float" explains
    // a command that otherwise looks as though it did nothing.
    const said = await run(set, () => ipc.tabPictureInPicture(id));
    if (typeof said === "string") get().notify(said);
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
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (!id) return;
    await run(set, async () => {
      const path = await ipc.tabBugReport(id);
      get().notify(`Bug report copied · saved ${fileNameOr(path, path)}`, 5000);
    });
  },
  devtools: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (id) await run(set, () => ipc.tabDevtools(id));
  },
  applyZoom: (id, factor) => {
    if (zoomInFlight.has(id) || zoomWanted.has(id)) return;
    if (!Number.isFinite(factor)) return;
    set((s) => (s.zoom[id] === factor ? s : { zoom: { ...s.zoom, [id]: factor } }));
  },
  zoomStep: async (direction, tabId) => {
    // A detached window names its own tab: it has no active tab of its own.
    const id = tabId ?? tabInThisWindow(get().activeTab, get().detached);
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
    const id = tabInThisWindow(get().activeTab, get().detached);
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
      get().notify(`Captured ${fileNameOr(path, path)}`, 4000);
    } catch (cause) {
      set({ error: errorMessage(cause) });
    } finally {
      set({ capturing: false });
    }
  },
  savePage: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (!id) return;
    try {
      const path = await ipc.pageSave(id);
      // No path means the save dialog was dismissed, which needs no notice.
      if (path) get().notify(`Saved ${fileNameOr(path, path)}`, 4000);
      set({ error: null });
    } catch (cause) {
      set({ error: errorMessage(cause) });
    }
  },
  readerView: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (!id) return;
    try {
      // Asking twice leaves reader view, so the command is a toggle wherever
      // it is invoked from -- the palette, the menu, the chord.
      if (await ipc.pageReaderOpen(id)) {
        await ipc.pageReaderLeave(id);
        get().setPageMode(id, { reader: false });
      } else {
        const result = await ipc.pageReader(id);
        if (result.ok) get().setPageMode(id, { reader: true });
        else get().notify(result.reason === "no-article" ? "There is no article on this page to read." : "This page could not be shown in reader view.", 4000);
      }
      set({ error: null });
    } catch (cause) {
      set({ error: errorMessage(cause) });
    }
  },
  translatePage: async () => {
    const id = tabInThisWindow(get().activeTab, get().detached);
    if (!id) return;
    const target = preferredLanguage();
    try {
      // Already translated into the browser's language, the command puts the
      // page back, the way reader view's does.
      if (get().pageModes[id]?.translated === target) {
        await ipc.pageTranslateRestore(id);
        get().setPageMode(id, { translated: null });
        set({ error: null });
        return;
      }
      const result = await ipc.pageTranslate(id, target);
      if (result.ok) {
        get().setPageMode(id, { translated: target });
        get().notify(`Translated from ${languageName(result.from ?? "")} into ${languageName(target)}.`, 3000);
      } else get().notify(translationMessage(result.reason, result.from, target), 4000);
      set({ error: null });
    } catch (cause) {
      set({ error: errorMessage(cause) });
    }
  },
  pageModes: {},
  setPageMode: (tabId, patch) =>
    set((s) => {
      const current = s.pageModes[tabId] ?? { reader: false, translated: null };
      const next = { ...current, ...patch };
      if (next.reader === current.reader && next.translated === current.translated && s.pageModes[tabId]) return s;
      return { pageModes: { ...s.pageModes, [tabId]: next } };
    }),
  reorderTabs: async (ordered) => {
    const ws = get().activeWorkspace;
    if (!ws) return;
    const prevTabs = get().tabs;
    // Optimistic: renumber locally, the engine confirms with one tabs_reordered event.
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
    supersedeSnapshots();
    // Kept for coming back, and drawn from what was kept when there is some.
    if (prev) workspaceViews.set(prev, { tabs: get().tabs.filter((t) => t.workspace_id === prev && t.tier !== "essential"), activeTab: get().activeTab });
    const cached = cachedStrip(workspaceViews.get(id), get().tabs, get().detached);
    const before = { tabs: get().tabs, activeTab: get().activeTab };
    set(cached ? { activeWorkspace: id, ...cached } : { activeWorkspace: id });
    requestedWorkspace = id;
    try {
      await ipc.workspaceActivate(id);
    } catch (e) {
      requestedWorkspace = null;
      set((s) => (s.activeWorkspace === id ? { activeWorkspace: prev, ...(cached ? before : {}), error: errorMessage(e) } : { error: errorMessage(e) }));
      return;
    }
    await run(set, () => applyLatestSnapshot(set));
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
    set((s) => ({ workspaces: mergeWorkspaceOrder(s.workspaces, ordered) }));
    try {
      await ipc.workspaceReorder(ordered);
      set({ error: null });
    } catch (e) {
      set({ workspaces: prevWorkspaces, error: errorMessage(e) });
    }
  },
  createWorkspace: async (draft, separateContainer) => {
    const intent = supersedeSnapshots();
    if (!(await succeeded(set, () => ipc.workspaceCreate(draft, separateContainer)))) return false;
    await applyLatestSnapshot(set, { editing: null }, intent);
    void get().refreshCounts();
    return true;
  },
  updateWorkspace: async (id, draft) => {
    const intent = supersedeSnapshots();
    if (!(await succeeded(set, () => ipc.workspaceUpdate(id, draft)))) return false;
    if (intent === intentRevision) set({ editing: null });
    return true;
  },
  deleteWorkspace: async (id) => {
    const intent = supersedeSnapshots();
    if (!(await succeeded(set, () => ipc.workspaceDelete(id)))) return false;
    await applyLatestSnapshot(set, { editing: null }, intent);
    void get().refreshCounts();
    return true;
  },

  toggle: (panel, value) => set((s) => ({ open: togglePanel(s.open, panel, value), ...(panel === "palette" ? { paletteFocus: "all" as const } : {}) })),
  applyEvent: (event) => {
    recordSnapshotDelta({ kind: "event", event });
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
        void run(set, () => applyLatestSnapshot(set));
        void get().refreshCounts();
      }
    }
    if (event.type === "tab_closed") {
      const id = event.data;
      unmarkClosing(id);
      for (const view of workspaceViews.values()) {
        if (view.tabs.some((t) => t.id === id)) view.tabs = view.tabs.filter((t) => t.id !== id);
      }
      const scroll = scrollOfClosing.get(id);
      scrollOfClosing.delete(id);
      set((s) => ({ closedTabs: rememberClosed(s.closedTabs, gone, goneIndex, scroll) }));
      set((s) => ({ loading: without(s.loading, id), navError: without(s.navError, id), crashedTabs: without(s.crashedTabs, id), permissionRequests: without(s.permissionRequests, id), zoom: without(s.zoom, id), pageModes: without(s.pageModes, id) }));
      zoomWanted.delete(id);
      // Dropped here rather than in closeTab: a tab the engine, an agent or a
      // popout closed never passes through it, and each kept up to 500
      // console lines and 1000 requests for the rest of the session.
      useConsole.getState().drop(id);
      useNetwork.getState().drop(id);
      usePrivacy.getState().drop(id);
      // Splits let go of a closed pane here, on the engine's word, rather
      // than whenever the chrome's tab list lacks it: that list is briefly
      // the old workspace's while a switch fetches the new one, and every
      // pane of the new workspace's split looked closed.
      useLayout.getState().forget(id);
      forgetClosedTab(id);
    }
    // A tab moved into another workspace leaves the split it sat in there.
    // Essentials show in every workspace, so their splits stay.
    if (event.type === "tab_upserted" && event.data.workspace_id && event.data.tier !== "essential") {
      useLayout.getState().forget(event.data.id, event.data.workspace_id);
    }
    // Badges count tabs per workspace, so only a tab arriving, leaving or
    // moving between workspaces changes them. Asking on every update asked
    // on every title change of every tab. Coalesced all the same: opening a
    // few tabs at once is one question.
    if (countsChanged(event)) scheduleCounts(get);
  },
}));

/** The workspace each tab was last seen in, across every workspace. */
const tabWorkspaces = new Map<string, string | null>();

/**
 * Whether `event` could change the per-workspace tab counts: a tab that is
 * new to this chrome or has changed workspace, or one that closed. Tabs of
 * other workspaces are remembered here even though the strip never holds
 * them. Exported for tests.
 */
export function countsChanged(event: CoreEvent): boolean {
  if (event.type === "tab_closed") {
    tabWorkspaces.delete(event.data);
    return true;
  }
  if (event.type !== "tab_upserted") return false;
  const { id, workspace_id } = event.data;
  if (tabWorkspaces.has(id) && tabWorkspaces.get(id) === workspace_id) return false;
  tabWorkspaces.set(id, workspace_id);
  return true;
}

let countsTimer: ReturnType<typeof setTimeout> | null = null;

/** Ask for tab counts once the current burst of tab events has settled. */
function scheduleCounts(get: () => BrowserState) {
  if (countsTimer) clearTimeout(countsTimer);
  countsTimer = setTimeout(() => {
    countsTimer = null;
    void get().refreshCounts();
  }, 300);
}

/** Like `run`, for a call whose result is nothing: whether it went through. */
async function succeeded(set: (p: Partial<BrowserState>) => void, f: () => Promise<unknown>): Promise<boolean> {
  try {
    await f();
    set({ error: null });
    return true;
  } catch (e) {
    set({ error: errorMessage(e) });
    return false;
  }
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
