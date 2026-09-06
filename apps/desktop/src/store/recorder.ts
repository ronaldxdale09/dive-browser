import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { RecordedStep } from "../lib/ipc";
import { useBrowser } from "./browser";
import { errorMessage } from "../lib/errors";

interface RecorderState {
  recordingTab: string | null;
  steps: RecordedStep[];
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  start: (tabId: string) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
}

let listening: Promise<() => void> | null = null;

export const useRecorder = create<RecorderState>((set, get) => ({
  recordingTab: null,
  steps: [],
  isOpen: false,
  setOpen: (isOpen) => set({ isOpen }),
  start: async (tabId) => {
    listening ??= events.recorderEvent.listen((e) => {
      if (e.payload.tab_id === get().recordingTab) set((s) => ({ steps: [...s.steps, e.payload.step] }));
    });
    await listening;
    try {
      await ipc.tabRecordStart(tabId);
      set({ recordingTab: tabId, steps: [], isOpen: false });
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  stop: async () => {
    const tab = get().recordingTab;
    if (!tab) return;
    const steps = await ipc.tabRecordStop(tab).catch(() => get().steps);
    set({ recordingTab: null, steps, isOpen: steps.length > 0 });
  },
  clear: () => set({ steps: [], isOpen: false }),
}));
