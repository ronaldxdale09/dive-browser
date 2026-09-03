import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { RecordedStep } from "../lib/ipc";
import { useBrowser } from "./browser";

interface RecorderState {
  recordingTab: string | null;
  steps: RecordedStep[];
  start: (tabId: string) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
}

let listening: Promise<() => void> | null = null;

export const useRecorder = create<RecorderState>((set, get) => ({
  recordingTab: null,
  steps: [],
  start: async (tabId) => {
    listening ??= events.recorderEvent.listen((e) => {
      if (e.payload.tab_id === get().recordingTab) set((s) => ({ steps: [...s.steps, e.payload.step] }));
    });
    await listening;
    try {
      await ipc.tabRecordStart(tabId);
      set({ recordingTab: tabId, steps: [] });
    } catch (e) {
      useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  stop: async () => {
    const tab = get().recordingTab;
    if (!tab) return;
    const steps = await ipc.tabRecordStop(tab).catch(() => get().steps);
    set({ recordingTab: null, steps });
  },
  clear: () => set({ steps: [] }),
}));
