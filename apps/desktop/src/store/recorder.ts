import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { RecordedStep } from "../lib/ipc";
import { useBrowser } from "./browser";
import { errorMessage } from "../lib/errors";

interface RecorderState {
  recordingTab: string | null;
  /** The page the recording began on: the spec's opening `goto`. */
  startUrl: string | null;
  startTitle: string | null;
  steps: RecordedStep[];
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  start: (tabId: string) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
}

let listening: Promise<() => void> | null = null;

/**
 * Subscribe once to recorded steps. A failed subscription is forgotten so the
 * next Record tries again; kept, it failed every later start without asking.
 */
function listenSteps(onStep: (step: RecordedStep, tab: string) => void): Promise<() => void> {
  if (listening) return listening;
  const request = events.recorderEvent.listen((e) => onStep(e.payload.step, e.payload.tab_id)).catch((error: unknown) => {
    if (listening === request) listening = null;
    throw error;
  });
  listening = request;
  return request;
}

/** As many steps as the host keeps (its RECORDED_STEP_CAP); a runaway page must not grow this list without end. */
export const STEP_CAP = 5000;

/** The steps with `step` appended, the oldest dropped past the cap. Pure for tests. */
export function appendStep(steps: readonly RecordedStep[], step: RecordedStep): RecordedStep[] {
  const next = [...steps, step];
  return next.length > STEP_CAP ? next.slice(next.length - STEP_CAP) : next;
}

export const useRecorder = create<RecorderState>((set, get) => ({
  recordingTab: null,
  startUrl: null,
  startTitle: null,
  steps: [],
  isOpen: false,
  setOpen: (isOpen) => set({ isOpen }),
  start: async (tabId) => {
    try {
      await listenSteps((step, tab) => {
        if (tab === get().recordingTab) set((s) => ({ steps: appendStep(s.steps, step) }));
      });
      await ipc.tabRecordStart(tabId);
      const tab = useBrowser.getState().tabs.find((t) => t.id === tabId);
      set({ recordingTab: tabId, startUrl: tab?.url ?? null, startTitle: tab?.title ?? null, steps: [], isOpen: false });
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
