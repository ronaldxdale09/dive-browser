import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { TabAudio } from "../lib/ipc";

/**
 * Which tabs are making a sound, and which have been silenced.
 *
 * The host reports both: the page tells it what is playing, and mute is
 * native, so a tab stays silent through a reload or a discard. The strip
 * draws a speaker from this, and clicking it is the fastest way to find out
 * which tab started talking.
 */
interface TabAudioStore {
  byTab: Record<string, TabAudio>;
  listening: boolean;
  init: () => Promise<void>;
  /** Silence a tab, or let it be heard again. */
  setMuted: (tabId: string, muted: boolean) => Promise<void>;
  toggle: (tabId: string) => Promise<void>;
  forget: (tabId: string) => void;
}

export const useTabAudio = create<TabAudioStore>((set, get) => ({
  byTab: {},
  listening: false,
  init: async () => {
    if (get().listening) return;
    set({ listening: true });
    try {
      await events.tabAudio.listen((e) => {
        const { tab_id: id, audible, muted } = e.payload;
        set((s) => {
          // A tab that is neither playing nor muted has nothing to draw.
          if (!audible && !muted) {
            if (!s.byTab[id]) return s;
            const rest = { ...s.byTab };
            delete rest[id];
            return { byTab: rest };
          }
          return { byTab: { ...s.byTab, [id]: e.payload } };
        });
      });
    } catch {
      // No host (a test, or a chrome without Tauri): nothing to listen to.
      set({ listening: false });
    }
  },
  setMuted: async (tabId, muted) => {
    // Answer the click at once; the host's own report confirms it.
    set((s) => ({ byTab: { ...s.byTab, [tabId]: { tab_id: tabId, audible: s.byTab[tabId]?.audible ?? false, muted } } }));
    await ipc.tabSetMuted(tabId, muted).catch(() => undefined);
  },
  toggle: async (tabId) => {
    await get().setMuted(tabId, !get().byTab[tabId]?.muted);
  },
  forget: (tabId) =>
    set((s) => {
      if (!s.byTab[tabId]) return s;
      const rest = { ...s.byTab };
      delete rest[tabId];
      return { byTab: rest };
    }),
}));
