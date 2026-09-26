import { create } from "zustand";
import { uiStorage } from "../lib/uiStorage";
import { ipc, events } from "../lib/ipc";
import type { SubtitleModel } from "../lib/ipc";
import { tabInThisWindow, useBrowser } from "./browser";
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
  /** Stop a model download; the partial file is removed. */
  cancelDownload: (modelId: string) => void;
  /** Delete a downloaded model from disk. */
  remove: (modelId: string) => Promise<void>;
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
}

const MODEL_KEY = "dive.subtitles.model";
const LANGUAGE_KEY = "dive.subtitles.language";
const TRANSLATE_KEY = "dive.subtitles.translate";

function thisWindowTab() {
  const { activeTab, detached } = useBrowser.getState();
  return tabInThisWindow(activeTab, detached);
}

/** The model chosen last time, so a download made once stays selected. */
export function rememberedModel(): string {
  try {
    return uiStorage.getItem(MODEL_KEY) ?? "base";
  } catch {
    return "base";
  }
}

function rememberModel(model: string) {
  remember(MODEL_KEY, model);
}

/**
 * The caption language chosen last time. Someone who watches Japanese video
 * picked Japanese once; it used to be back to English at every launch.
 */
export function rememberedLanguage(): string {
  try {
    return uiStorage.getItem(LANGUAGE_KEY) ?? "en";
  } catch {
    return "en";
  }
}

/** Whether translation to English was on last time. */
export function rememberedTranslate(): boolean {
  try {
    return uiStorage.getItem(TRANSLATE_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(key: string, value: string) {
  try {
    uiStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the session still works.
  }
}

export const useSubtitles = create<SubtitlesState>((set, get) => ({
  active: false,
  starting: false,
  language: rememberedLanguage(),
  translate: rememberedTranslate(),
  model: rememberedModel(),
  models: [],
  downloading: {},
  lastCue: "",
  error: null,
  setLanguage: (language) => {
    remember(LANGUAGE_KEY, language);
    set({ language });
  },
  setTranslate: (translate) => {
    remember(TRANSLATE_KEY, translate ? "1" : "0");
    set({ translate });
  },
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
    cancelledDownloads.delete(modelId);
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

  cancelDownload: (modelId) => {
    // The row goes back at once; the host's "cancelled" report that follows
    // finds nothing left to clear, and progress still in flight is ignored.
    cancelledDownloads.add(modelId);
    set((s) => ({ downloading: without(s.downloading, modelId) }));
    void ipc.subtitleModelCancel(modelId).catch(() => undefined);
  },

  remove: async (modelId) => {
    try {
      await ipc.subtitleModelDelete(modelId);
      set((s) => ({ error: null, models: s.models.map((m) => (m.id === modelId ? { ...m, downloaded: false } : m)) }));
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  start: async () => {
    if (get().starting) return false;
    const tab = thisWindowTab();
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
      if (thisWindowTab() === tab) set({ active: true, error: null, lastCue: "Waiting for video audio…" });
      return true;
    } catch (e) {
      if (attempt !== startAttempt) return false;
      if (thisWindowTab() === tab) set({ active: false, error: errorMessage(e), lastCue: "" });
      return false;
    } finally {
      if (attempt === startAttempt) set({ starting: false });
    }
  },

  stop: async () => {
    const tab = thisWindowTab();
    if (!tab) return;
    ++startAttempt;
    set({ starting: false });
    try {
      await ipc.subtitleStop(tab);
      if (thisWindowTab() === tab) set({ active: false, error: null, lastCue: "" });
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


/** Models whose download was cancelled; late progress for them is not shown. */
const cancelledDownloads = new Set<string>();

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
        if (p.cancelled) {
          cancelledDownloads.delete(p.id);
          return { downloading: without(s.downloading, p.id) };
        }
        if (cancelledDownloads.has(p.id)) return {};
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
      const tab = thisWindowTab();
      // Only this window's tab drives the chrome; a torn-off tab's session
      // stays in the window that owns it.
      if (!tab || st.tab_id !== tab) return;
      stateRevision++;
      useSubtitles.setState({ active: st.active, error: st.error, ...(st.active ? {} : { lastCue: "" }) });
    }));
    subscriptions.push(await events.subtitleCue.listen((e) => {
      const cue = e.payload;
      const tab = thisWindowTab();
      if (!tab || cue.tab_id !== tab) return;
      useSubtitles.setState({ lastCue: cue.text });
    }));
    subscriptions.push(useBrowser.subscribe((current, previous) => {
      const now = tabInThisWindow(current.activeTab, current.detached);
      const was = tabInThisWindow(previous.activeTab, previous.detached);
      if (now === was) return;
      const revision = ++stateRevision;
      useSubtitles.setState({ active: false, lastCue: "", error: null });
      if (now) {
        void ipc.subtitleRunning(now).then((active) => {
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
