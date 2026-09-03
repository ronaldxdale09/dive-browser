import { create } from "zustand";
import { ipc, events } from "../lib/ipc";
import { listenConsole, useConsole } from "./console";
import { listenNetwork, useNetwork } from "./network";
import type { CoreEvent, Snapshot, Tab, Workspace } from "../lib/ipc";

export type UiPanel = "sidecar" | "dock" | "palette" | "find" | "settings";

interface BrowserState {
  ready: boolean;
  workspaces: Workspace[];
  activeWorkspace: string | null;
  tabs: Tab[];
  activeTab: string | null;
  open: Record<UiPanel, boolean>;
  error: string | null;
  boot: () => Promise<void>;
  openTab: (url: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  reload: () => Promise<void>;
  capture: (fullPage: boolean) => Promise<void>;
  /** Zoom factor per tab; absent means 1. */
  zoom: Record<string, number>;
  zoomStep: (direction: 1 | -1 | 0) => Promise<void>;
  devtools: () => Promise<void>;
  notice: string | null;
  /** Path of the capture currently open in the annotator. */
  annotating: string | null;
  setAnnotating: (path: string | null) => void;
  reorderTabs: (ordered: string[]) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  activateWorkspace: (id: string) => Promise<void>;
  createWorkspace: (draft: { name: string; color: string }, separateContainer: boolean) => Promise<void>;
  updateWorkspace: (id: string, draft: { name: string; color: string }) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  editing: { id: string | null } | null;
  setEditing: (v: { id: string | null } | null) => void;
  toggle: (panel: UiPanel, value?: boolean) => void;
  applyEvent: (event: CoreEvent) => void;
}

/** Reduce one core event into local state. Pure, so it is unit-testable. */
export function reduceEvent(
  state: Pick<BrowserState, "workspaces" | "tabs" | "activeTab" | "activeWorkspace">,
  event: CoreEvent,
): Partial<Pick<BrowserState, "workspaces" | "tabs" | "activeTab" | "activeWorkspace">> {
  switch (event.type) {
    case "workspace_upserted": {
      const others = state.workspaces.filter((w) => w.id !== event.data.id);
      return { workspaces: [...others, event.data].sort((a, b) => a.position - b.position) };
    }
    case "workspace_removed":
      return { workspaces: state.workspaces.filter((w) => w.id !== event.data) };
    case "workspace_activated":
      return { activeWorkspace: event.data };
    case "tab_upserted": {
      const idx = state.tabs.findIndex((t) => t.id === event.data.id);
      const tabs = idx === -1 ? [...state.tabs, event.data] : state.tabs.map((t, i) => (i === idx ? event.data : t));
      return { tabs };
    }
    case "tab_closed": {
      // The engine picks the replacement and announces it with tab_activated.
      const tabs = state.tabs.filter((t) => t.id !== event.data);
      const activeTab = state.activeTab === event.data ? null : state.activeTab;
      return { tabs, activeTab };
    }
    case "tab_activated":
      return { activeTab: event.data };
    default:
      return {};
  }
}

function fromSnapshot(s: Snapshot) {
  return { workspaces: s.workspaces, activeWorkspace: s.active_workspace, tabs: s.tabs, activeTab: s.active_tab };
}

let unlisten: (() => void) | null = null;

export const useBrowser = create<BrowserState>((set, get) => ({
  ready: false,
  workspaces: [],
  activeWorkspace: null,
  tabs: [],
  activeTab: null,
  open: { sidecar: false, dock: false, palette: false, find: false, settings: false },
  error: null,
  notice: null,
  annotating: null,
  zoom: {},
  setAnnotating: (path) => set({ annotating: path }),
  editing: null,
  setEditing: (editing) => set({ editing }),

  boot: async () => {
    try {
      unlisten ??= await events.stateChanged.listen((e) => get().applyEvent(e.payload));
      await events.downloadNotice.listen((e) => {
        const d = e.payload;
        const name = d.path.split("/").pop() ?? d.url;
        set({ notice: d.status === "started" ? `Downloading ${name}` : d.status === "finished" ? `Saved ${name}` : `Download failed: ${name}` });
        setTimeout(() => set({ notice: null }), 5000);
      });
      await Promise.all([listenConsole(), listenNetwork()]);
      set({ ...fromSnapshot(await ipc.snapshot()), ready: true, error: null });
    } catch (e) {
      set({ error: String(e), ready: true });
    }
  },

  openTab: async (url) => {
    const ws = get().activeWorkspace;
    if (!ws) return;
    await run(set, () => ipc.tabOpen(ws, url));
  },
  closeTab: async (id) => {
    await run(set, () => ipc.tabClose(id));
    useConsole.getState().drop(id);
    useNetwork.getState().drop(id);
  },
  activateTab: async (id) => run(set, () => ipc.tabActivate(id)),
  navigate: async (url) => {
    const id = get().activeTab;
    if (!id) return get().openTab(url);
    await run(set, () => ipc.tabNavigate(id, url));
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
    if (!id) return;
    await run(set, async () => {
      const path = await ipc.tabCapture(id, fullPage);
      set({ annotating: path, notice: `Copied to clipboard · saved ${path.split("/").pop() ?? path}` });
      setTimeout(() => set({ notice: null }), 4000);
    });
  },
  reorderTabs: async (ordered) => {
    const ws = get().activeWorkspace;
    if (!ws) return;
    // Optimistic: renumber locally, the engine confirms with tab_upserted events.
    set((s) => ({ tabs: s.tabs.map((t) => (ordered.includes(t.id) ? { ...t, position: ordered.indexOf(t.id) } : t)) }));
    await run(set, () => ipc.tabReorder(ws, ordered));
  },
  setPinned: async (id, pinned) => run(set, () => ipc.tabSetPinned(id, pinned)),
  activateWorkspace: async (id) => {
    await run(set, () => ipc.workspaceActivate(id));
    set(fromSnapshot(await ipc.snapshot()));
  },
  createWorkspace: async (draft, separateContainer) => {
    await run(set, () => ipc.workspaceCreate(draft, separateContainer));
    set({ ...fromSnapshot(await ipc.snapshot()), editing: null });
  },
  updateWorkspace: async (id, draft) => {
    await run(set, () => ipc.workspaceUpdate(id, draft));
    set({ editing: null });
  },
  deleteWorkspace: async (id) => {
    await run(set, () => ipc.workspaceDelete(id));
    set({ ...fromSnapshot(await ipc.snapshot()), editing: null });
  },

  toggle: (panel, value) => set((s) => ({ open: { ...s.open, [panel]: value ?? !s.open[panel] } })),
  applyEvent: (event) => set((s) => reduceEvent(s, event)),
}));

async function run(set: (p: Partial<BrowserState>) => void, f: () => Promise<unknown>) {
  try {
    await f();
    set({ error: null });
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

/** Zoom levels the chrome steps through; mirrors ZOOM_STEPS in commands.rs. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function nextZoom(current: number, direction: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((z) => Math.abs(z - current) < 0.001);
  const j = i === -1 ? ZOOM_STEPS.findIndex((z) => z > current) - (direction === 1 ? 0 : 1) : i + direction;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, j))] ?? 1;
}
