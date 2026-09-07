import { create } from "zustand";
import { uiStorage } from "../lib/uiStorage";
import { ipc, events } from "../lib/ipc";
import type { SubtitleModel } from "../lib/ipc";
import { useBrowser } from "./browser";
import { errorMessage } from "../lib/errors";

/** Bytes seen and expected for a model that is downloading; `total` is null until the server reports a length. */
export type DownloadProgress = { received: number; total: number | null };
let startAttempt = 0;

interface SubtitlesState {
  /** Running on the active tab, per the last `subtitle-state` event. */
  active: boolean;
  starting: boolean;
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
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
}

const MODEL_KEY = "dive.subtitles.model";

/** The model chosen last time, so a download made once stays selected. */
export function rememberedModel(): string {
  try {
    return uiStorage.getItem(MODEL_KEY) ?? "base";
  } catch {
    return "base";
  }
}

function rememberModel(model: string) {
  try {
    uiStorage.setItem(MODEL_KEY, model);
  } catch {
    // Storage can be unavailable; the session still works.
  }
}

export const useSubtitles = create<SubtitlesState>((set, get) => ({
  active: false,
  starting: false,
  language: "en",
  translate: false,
  model: rememberedModel(),
  models: [],
  downloading: {},
  lastCue: "",
  error: null,
  setLanguage: (language) => set({ language }),
  setTranslate: (translate) => set({ translate }),
  setModel: (model) => {
    rememberModel(model);
    set({ model });
  },

  loadModels: async () => {
    try {
      const models = await ipc.subtitleModels();
      // A selection that was never downloaded gives way to one that was, so
      // Start is ready as soon as any model is on disk.
      const chosen = models.find((m) => m.id === get().model);
      const fallback = chosen?.downloaded ? null : models.find((m) => m.downloaded);
      set({ models, error: null, ...(fallback ? { model: fallback.id } : {}) });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  download: async (modelId) => {
    if (get().downloading[modelId]) return;
    // Fetching a model is choosing it: someone who downloads Tiny while Base
    // is selected expects Start to light up for Tiny, not stay grey for Base.
    const chosen = get().models.find((m) => m.id === get().model);
    if (!chosen?.downloaded && get().model !== modelId) get().setModel(modelId);
    set((s) => ({ downloading: { ...s.downloading, [modelId]: { received: 0, total: null } }, error: null }));
    try {
      await ipc.subtitleModelDownload(modelId);
    } catch (e) {
      set((s) => ({ downloading: without(s.downloading, modelId), error: errorMessage(e) }));
    }
  },

  start: async () => {
    if (get().starting) return false;
    const tab = useBrowser.getState().activeTab;
    if (!tab) {
      set({ error: "Open a tab with a playing video first." });
      return false;
    }
    const { model, models, language, translate } = get();
    const chosen = models.find((m) => m.id === model);
    if (!chosen?.downloaded) {
      set({ error: "Download this model before starting subtitles." });
      return false;
    }
    set({ starting: true, error: null, lastCue: "Loading local model…" });
    const attempt = ++startAttempt;
    try {
      await ipc.subtitleStart(tab, model, language, translate);
      if (attempt !== startAttempt) return false;
      if (useBrowser.getState().activeTab === tab) set({ active: true, error: null, lastCue: "Waiting for video audio…" });
      return true;
    } catch (e) {
      if (attempt !== startAttempt) return false;
      if (useBrowser.getState().activeTab === tab) set({ active: false, error: errorMessage(e), lastCue: "" });
      return false;
    } finally {
      if (attempt === startAttempt) set({ starting: false });
    }
  },

  stop: async () => {
    const tab = useBrowser.getState().activeTab;
    if (!tab) return;
    ++startAttempt;
    set({ starting: false });
    try {
      await ipc.subtitleStop(tab);
      if (useBrowser.getState().activeTab === tab) set({ active: false, error: null, lastCue: "" });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },
}));

/** Drop `key` from a record without mutating it. */
function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  return Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
}


let listening = false;
const subscriptions: (() => void)[] = [];
let stateRevision = 0;

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
    subscriptions.push(await events.subtitleModelProgress.listen((e) => {
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
    }));
    subscriptions.push(await events.subtitleState.listen((e) => {
      const st = e.payload;
      const tab = useBrowser.getState().activeTab;
      // Only the active tab's state drives the chrome; other tabs' state is
      // theirs. When no tab is active yet, take it anyway.
      if (tab && st.tab_id !== tab) return;
      stateRevision++;
      useSubtitles.setState({ active: st.active, error: st.error, ...(st.active ? {} : { lastCue: "" }) });
    }));
    subscriptions.push(await events.subtitleCue.listen((e) => {
      const cue = e.payload;
      const tab = useBrowser.getState().activeTab;
      if (tab && cue.tab_id !== tab) return;
      useSubtitles.setState({ lastCue: cue.text });
    }));
    subscriptions.push(useBrowser.subscribe((current, previous) => {
      if (current.activeTab === previous.activeTab) return;
      const revision = ++stateRevision;
      useSubtitles.setState({ active: false, lastCue: "", error: null });
      if (current.activeTab) {
        void ipc.subtitleRunning(current.activeTab).then((active) => {
          if (revision === stateRevision) useSubtitles.setState({ active });
        }).catch(() => undefined);
      }
    }));
  } catch (e) {
    subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
    listening = false;
    useSubtitles.setState({ error: errorMessage(e) });
  }
}

/** Tests only: forget the singleton subscription. */
export function resetSubtitlesListener() {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  stateRevision++;
  listening = false;
}
