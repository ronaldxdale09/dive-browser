import { create } from "zustand";
import { ipc, events } from "../lib/ipc";
import type { CoreEvent, Snapshot, Tab, Workspace } from "../lib/ipc";

export type UiPanel = "sidecar" | "dock" | "palette";

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
  activateWorkspace: (id: string) => Promise<void>;
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
      const tabs = state.tabs.filter((t) => t.id !== event.data);
      const activeTab = state.activeTab === event.data ? (tabs.at(-1)?.id ?? null) : state.activeTab;
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
  open: { sidecar: false, dock: false, palette: false },
  error: null,

  boot: async () => {
    try {
      unlisten ??= await events.stateChanged.listen((e) => get().applyEvent(e.payload));
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
  closeTab: async (id) => run(set, () => ipc.tabClose(id)),
  activateTab: async (id) => run(set, () => ipc.tabActivate(id)),
  navigate: async (url) => {
    const id = get().activeTab;
    if (!id) return get().openTab(url);
    await run(set, () => ipc.tabNavigate(id, url));
  },
  activateWorkspace: async (id) => {
    await run(set, () => ipc.workspaceActivate(id));
    set(fromSnapshot(await ipc.snapshot()));
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

/** Tabs of the active workspace only, split by tier for the strip. */
export function selectStrip(s: BrowserState) {
  const essentials = s.tabs.filter((t) => t.tier === "essential");
  const pinned = s.tabs.filter((t) => t.tier === "pinned");
  const today = s.tabs.filter((t) => t.tier === "today" && t.state !== "discarded");
  return { essentials, pinned, today };
}
