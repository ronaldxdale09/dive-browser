import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Tab } from "../lib/ipc";

/** Most panes a split can hold; past this the pages are too narrow to use. */
export const MAX_PANES = 4;
/** Narrowest a pane may be dragged, as a fraction of the row. */
export const MIN_PANE = 0.15;

/** A split: which tabs sit side by side, and how wide each is (fractions summing to 1). */
export interface Split {
  tabs: string[];
  sizes: number[];
}

interface LayoutState {
  /** Split per workspace id. A workspace without one shows a single page. */
  splits: Record<string, Split>;
  /** Put `tab` into the workspace's split at `index`, creating the split beside `anchor` if there is none. */
  insert: (workspace: string, tab: string, index: number, anchor: string | null) => void;
  /** Take `tab` out of the split; a split of one pane goes away. */
  remove: (workspace: string, tab: string) => void;
  resize: (workspace: string, sizes: number[]) => void;
  clear: (workspace: string) => void;
}

function without(splits: Record<string, Split>, ws: string): Record<string, Split> {
  return Object.fromEntries(Object.entries(splits).filter(([k]) => k !== ws));
}

function even(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/** Pure form of `insert`, so the drop rules can be tested without a store. */
export function insertPane(split: Split | undefined, tab: string, index: number, anchor: string | null): Split | undefined {
  const base = split?.tabs.length ? split.tabs : anchor && anchor !== tab ? [anchor] : [];
  const tabs = base.filter((t) => t !== tab);
  // Removing the tab from before the target shifts the target left by one.
  const before = base.slice(0, index).filter((t) => t === tab).length;
  const at = Math.max(0, Math.min(tabs.length, index - before));
  tabs.splice(at, 0, tab);
  if (tabs.length < 2) return undefined;
  if (tabs.length > MAX_PANES) return split;
  return { tabs, sizes: even(tabs.length) };
}

export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => ({
      splits: {},
      insert: (ws, tab, index, anchor) => {
        const next = insertPane(get().splits[ws], tab, index, anchor);
        const rest = without(get().splits, ws);
        set({ splits: next ? { ...rest, [ws]: next } : rest });
      },
      remove: (ws, tab) => {
        const cur = get().splits[ws];
        if (!cur) return;
        const tabs = cur.tabs.filter((t) => t !== tab);
        const rest = without(get().splits, ws);
        set({ splits: tabs.length >= 2 ? { ...rest, [ws]: { tabs, sizes: even(tabs.length) } } : rest });
      },
      resize: (ws, sizes) => {
        const cur = get().splits[ws];
        if (!cur || sizes.length !== cur.tabs.length) return;
        set({ splits: { ...get().splits, [ws]: { ...cur, sizes } } });
      },
      clear: (ws) => set({ splits: without(get().splits, ws) }),
    }),
    { name: "dive.layout", version: 1 },
  ),
);

/**
 * The split to show right now, or `null` for a single page: the workspace's
 * split when the active tab is one of its panes and every pane is still an
 * open tab in this window. Clicking a tab outside the split leaves it, as
 * in every browser with one; the split waits for a pane to be clicked.
 */
export function visibleSplit(split: Split | undefined, activeTab: string | null, tabs: Tab[], detached: string[]): Split | null {
  if (!split || !activeTab || !split.tabs.includes(activeTab)) return null;
  const live = new Set(tabs.map((t) => t.id));
  if (split.tabs.some((t) => !live.has(t) || detached.includes(t))) return null;
  return split;
}
