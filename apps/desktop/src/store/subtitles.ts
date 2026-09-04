import { create } from "zustand";
import { ipc, events } from "../lib/ipc";
import type { SubtitleModel } from "../lib/ipc";
import { useBrowser } from "./browser";

/** Bytes seen and expected for a model that is downloading; `total` is null until the server reports a length. */
export type DownloadProgress = { received: number; total: number | null };

interface SubtitlesState {
  /** Running on the active tab, per the last `subtitle-state` event. */
  active: boolean;
  /** Chosen caption language: an ISO code or "auto". */
  language: string;
  /** Render English regardless of the spoken language. */
  translate: boolean;
  /** Chosen model id. */
  model: string;
  /** Every downloadable model, with whether it is on disk. */
  models: SubtitleModel[];
  /** In-flight downloads by model id. */
  downloading: Record<string, DownloadProgress>;
  /** The latest caption line, for the small status readout. */
  lastCue: string;
  /** The last error from starting, downloading, or staying running. */
  error: string | null;
  setLanguage: (language: string) => void;
  setTranslate: (translate: boolean) => void;
  setModel: (model: string) => void;
  loadModels: () => Promise<void>;
  download: (modelId: string) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export const useSubtitles = create<SubtitlesState>((set, get) => ({
  active: false,
  language: "en",
  translate: false,
  model: "base",
  models: [],
  downloading: {},
  lastCue: "",
  error: null,
  setLanguage: (language) => set({ language }),
  setTranslate: (translate) => set({ translate }),
  setModel: (model) => set({ model }),

  loadModels: async () => {
    try {
      const models = await ipc.subtitleModels();
      set({ models, error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  download: async (modelId) => {
    if (get().downloading[modelId]) return;
    set((s) => ({ downloading: { ...s.downloading, [modelId]: { received: 0, total: null } }, error: null }));
    try {
      await ipc.subtitleModelDownload(modelId);
    } catch (e) {
      set((s) => ({ downloading: without(s.downloading, modelId), error: message(e) }));
    }
  },

  start: async () => {
    const tab = useBrowser.getState().activeTab;
    if (!tab) {
      set({ error: "Open a tab with a playing video first." });
      return;
    }
    const { model, models, language, translate } = get();
    const chosen = models.find((m) => m.id === model);
    if (!chosen?.downloaded) {
      set({ error: "Download this model before starting subtitles." });
      return;
    }
    try {
      await ipc.subtitleStart(tab, model, language, translate);
      set({ error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  stop: async () => {
    const tab = useBrowser.getState().activeTab;
    if (!tab) return;
    try {
      await ipc.subtitleStop(tab);
      set({ active: false, error: null });
    } catch (e) {
      set({ error: message(e) });
    }
  },
}));

/** Drop `key` from a record without mutating it. */
function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  return Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let listening = false;

/**
 * Subscribe once to the subtitle events. Idempotent, like the other stores'
 * listeners: a second call is a no-op so a remount never doubles up. Progress
 * updates `downloading` and flips a model to `downloaded` on `done`; state
 * events set `active`/`error`; cues fill the status readout.
 */
export async function bootSubtitles(): Promise<void> {
  if (listening) return;
  listening = true;
  try {
    await events.subtitleModelProgress.listen((e) => {
      const p = e.payload;
      useSubtitles.setState((s) => {
        if (p.error) {
          return { downloading: without(s.downloading, p.id), error: p.error };
        }
        if (p.done) {
          return {
            downloading: without(s.downloading, p.id),
            models: s.models.map((m) => (m.id === p.id ? { ...m, downloaded: true } : m)),
          };
        }
        return { downloading: { ...s.downloading, [p.id]: { received: p.received ?? 0, total: p.total } } };
      });
    });
    await events.subtitleState.listen((e) => {
      const st = e.payload;
      const tab = useBrowser.getState().activeTab;
      // Only the active tab's state drives the chrome; other tabs' state is
      // theirs. When no tab is active yet, take it anyway.
      if (tab && st.tab_id !== tab) return;
      useSubtitles.setState({ active: st.active, error: st.error, ...(st.active ? {} : { lastCue: "" }) });
    });
    await events.subtitleCue.listen((e) => {
      const cue = e.payload;
      const tab = useBrowser.getState().activeTab;
      if (tab && cue.tab_id !== tab) return;
      useSubtitles.setState({ lastCue: cue.text });
    });
  } catch (e) {
    listening = false;
    useSubtitles.setState({ error: message(e) });
  }
}

/** Tests only: forget the singleton subscription. */
export function resetSubtitlesListener() {
  listening = false;
}
