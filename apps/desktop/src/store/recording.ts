import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { uiStorage } from "../lib/uiStorage";
import { events, ipc } from "../lib/ipc";
import type { RecordingCapabilities, RecordingEvent, RecordingResult } from "../lib/ipc";
import { tabInThisWindow, useBrowser } from "./browser";

/**
 * Screen recording, start to finish: the setup dialog, a countdown, the
 * recording itself with pause and resume, and the finished file. One
 * recording at a time; the settings are remembered between recordings.
 *
 * A save that fails ends in `failed`: capture is over, the engine keeps
 * what was captured, and the person tries again or throws it away.
 */

export type RecordFormat = "mp4" | "gif";
/** The page's own paint, or Dive's whole window as it appears on screen. */
export type RecordSource = "page" | "window";

export interface RecordSettings {
  source: RecordSource;
  format: RecordFormat;
  fps: 15 | 30;
  /** Widest the picture may be, in CSS pixels: 720p-ish or 1080p-ish. */
  width: 1280 | 1920;
  /** Capture-device id, or null for no microphone. */
  microphone: string | null;
  /** Three-second countdown before the first frame. */
  countdown: boolean;
}

export type Phase = "idle" | "setup" | "starting" | "countdown" | "recording" | "paused" | "finishing" | "failed" | "done";

interface RecordingState {
  phase: Phase;
  /** The tab being (or about to be) recorded. */
  tab: string | null;
  settings: RecordSettings;
  caps: RecordingCapabilities | null;
  /** Seconds left in the countdown. */
  countdown: number;
  /** When recording began, and how much of the time since was paused. */
  startedAt: number | null;
  pausedAt: number | null;
  pausedTotal: number;
  /** The length cap was reached; the file holds what fits. */
  limitHit: boolean;
  /** Share of the save done, 0 to 1, while finishing; null before ffmpeg says. */
  progress: number | null;
  /** This recording asked for a microphone. */
  micRequested: boolean;
  /** The microphone stopped partway through the recording. */
  micFailed: boolean;
  result: RecordingResult | null;
  error: string | null;

  loadCaps: () => Promise<void>;
  /** Open the setup dialog, aimed at `tab` or the active tab. */
  openSetup: (tab?: string | null) => void;
  closeSetup: () => void;
  setTab: (tab: string) => void;
  setSettings: (patch: Partial<RecordSettings>) => void;
  /** ⌘⌥⇧R: open setup when idle, stop when recording. */
  toggle: () => Promise<void>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** Stop and save; from `failed`, try the save again. */
  stop: () => Promise<void>;
  /** Stop a save in progress; the recording is kept, as after a failed save. */
  stopSaving: () => Promise<void>;
  /** Throw the recording away. */
  cancel: () => Promise<void>;
  /** Close the finished dialog. */
  dismiss: () => void;
  deleteResult: () => Promise<void>;
}

export const DEFAULT_SETTINGS: RecordSettings = { source: "page", format: "mp4", fps: 30, width: 1280, microphone: null, countdown: true };

const COUNTDOWN_SECONDS = 3;
let countdownTimer = 0;
let listening = false;

/** What the engine says when it holds no recording for the tab. */
const NOT_RECORDING = "not recording this tab";

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : typeof error === "string" && error ? error : fallback);

/** Seconds recorded so far, pauses excluded. */
export function elapsedSeconds(s: Pick<RecordingState, "startedAt" | "pausedAt" | "pausedTotal">, now = Date.now()): number {
  if (s.startedAt === null) return 0;
  const paused = s.pausedTotal + (s.pausedAt === null ? 0 : now - s.pausedAt);
  return Math.max(0, (now - s.startedAt - paused) / 1000);
}

/** What a recording of these settings costs and allows, for the dialog's footnote. */
export function describeLimits(settings: RecordSettings, caps: RecordingCapabilities | null): string {
  const seconds = settings.format === "gif" ? (caps?.gif_max_seconds ?? 60) : (caps?.video_max_seconds ?? 600);
  const length = seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
  return settings.source === "window"
    ? `Up to ${length}. Records Dive's window as it appears on screen, pointer included; keep it in front and still.`
    : `Up to ${length}. Records the page itself; Dive's own controls and the pointer are not in the picture.`;
}

/** Settings the machine can honour: no video or microphone without ffmpeg. */
export function effectiveSettings(settings: RecordSettings, caps: RecordingCapabilities | null): RecordSettings {
  if (!caps) return settings;
  if (!caps.ffmpeg) return { ...settings, source: "page", format: "gif", microphone: null };
  const known = settings.microphone !== null && caps.microphones.some((m) => m.id === settings.microphone);
  return { ...settings, microphone: settings.format === "gif" || !known ? null : settings.microphone };
}

export const useRecording = create<RecordingState>()(
  persist(
    (set, get) => ({
      phase: "idle",
      tab: null,
      settings: DEFAULT_SETTINGS,
      caps: null,
      countdown: 0,
      startedAt: null,
      pausedAt: null,
      pausedTotal: 0,
      limitHit: false,
      progress: null,
      micRequested: false,
      micFailed: false,
      result: null,
      error: null,

      loadCaps: async () => {
        try {
          set({ caps: await ipc.recordingCapabilities() });
        } catch (e) {
          set({ caps: { ffmpeg: false, microphones: [], video_max_seconds: 600, gif_max_seconds: 60 }, error: errorMessage(e, "Recording capabilities could not be loaded") });
        }
      },

      openSetup: (tab) => {
        const { phase } = get();
        if (phase !== "idle" && phase !== "done") return;
        const { activeTab, detached } = useBrowser.getState();
        const target = tab ?? tabInThisWindow(activeTab, detached);
        if (!target) return;
        listen();
        set({ phase: "setup", tab: target, result: null, error: null, limitHit: false });
        void get().loadCaps();
      },
      closeSetup: () => {
        if (get().phase === "setup") set({ phase: "idle", tab: null });
      },
      setTab: (tab) => set({ tab }),
      setSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),

      toggle: async () => {
        const { phase } = get();
        if (phase === "recording" || phase === "paused" || phase === "failed") await get().stop();
        else if (phase === "countdown") await get().cancel();
        else if (phase !== "finishing") get().openSetup();
      },

      start: async () => {
        const { tab, phase } = get();
        if (!tab || phase !== "setup") return;
        const settings = effectiveSettings(get().settings, get().caps);
        set({ settings, phase: "starting", error: null });
        try {
          // The recording follows the chosen tab; it has to be showing so the
          // page keeps painting frames.
          if (useBrowser.getState().activeTab !== tab) await useBrowser.getState().activateTab(tab);
          if (settings.countdown) {
            set({ phase: "countdown", countdown: COUNTDOWN_SECONDS });
            await new Promise<void>((resolve) => {
              const tick = () => {
                const { phase, countdown } = get();
                if (phase !== "countdown") return resolve();
                if (countdown <= 1) return resolve();
                set({ countdown: countdown - 1 });
                countdownTimer = window.setTimeout(tick, 1000);
              };
              countdownTimer = window.setTimeout(tick, 1000);
            });
            if (get().phase !== "countdown") return;
          }
          await ipc.tabScreencastStart(tab, { source: settings.source, format: settings.format, fps: settings.fps, max_width: settings.width, microphone: settings.microphone });
          // The tab closed while the engine was starting: nothing is shown
          // for this recording any more, so it must not keep running.
          if (get().tab !== tab || get().phase === "idle") {
            await ipc.tabScreencastCancel(tab).catch(() => undefined);
            return;
          }
          set({ phase: "recording", startedAt: Date.now(), pausedAt: null, pausedTotal: 0, limitHit: false, progress: null, micRequested: settings.microphone !== null, micFailed: false, error: null });
          useBrowser.setState({ recordingTab: tab });
        } catch (e) {
          if (get().tab === tab && get().phase !== "idle") set({ phase: "setup", error: errorMessage(e, "Recording could not be started") });
        }
      },

      pause: async () => {
        const { tab, phase } = get();
        if (!tab || phase !== "recording") return;
        try {
          await ipc.tabScreencastPause(tab, true);
          set({ phase: "paused", pausedAt: Date.now(), error: null });
        } catch (e) {
          set({ error: errorMessage(e, "Recording could not be paused") });
        }
      },
      resume: async () => {
        const { tab, phase, pausedAt, pausedTotal } = get();
        if (!tab || phase !== "paused") return;
        try {
          await ipc.tabScreencastPause(tab, false);
          set({ phase: "recording", pausedAt: null, pausedTotal: pausedTotal + (pausedAt === null ? 0 : Date.now() - pausedAt), error: null });
        } catch (e) {
          set({ error: errorMessage(e, "Recording could not be resumed") });
        }
      },

      stop: async () => {
        const { tab, phase } = get();
        if (!tab || (phase !== "recording" && phase !== "paused" && phase !== "failed")) return;
        set({ phase: "finishing", progress: null, error: null });
        try {
          const result = await ipc.tabScreencastStop(tab);
          useBrowser.setState({ recordingTab: null });
          set({ phase: "done", result, error: null, progress: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
        } catch (e) {
          const message = errorMessage(e, "Recording could not be saved");
          // A retry the engine has nothing for: the first failure found
          // nothing captured, and a button to try again would only fail again.
          if (phase === "failed" && message === NOT_RECORDING) {
            useBrowser.setState({ recordingTab: null, error: "Nothing was captured, so there is no recording to save" });
            set({ phase: "idle", tab: null, error: null, progress: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
            return;
          }
          // Capture has ended either way. The engine keeps the frames, so
          // the save can be tried again; staying in `recording` used to
          // offer a pause and a ticking clock for a recording that was over.
          set({ phase: "failed", progress: null, error: message });
        }
      },

      stopSaving: async () => {
        const { tab, phase } = get();
        // The pending stop, or the engine's `failed` event for a save it
        // began itself, moves the recording on to `failed`.
        if (tab && phase === "finishing") await ipc.tabScreencastCancel(tab).catch(() => undefined);
      },

      cancel: async () => {
        const { tab, phase } = get();
        window.clearTimeout(countdownTimer);
        if (phase === "finishing") return get().stopSaving();
        if (tab && (phase === "recording" || phase === "paused" || phase === "failed")) await ipc.tabScreencastCancel(tab).catch(() => undefined);
        useBrowser.setState({ recordingTab: null });
        set({ phase: "idle", tab: null, startedAt: null, pausedAt: null, pausedTotal: 0, countdown: 0, progress: null, error: null });
      },

      dismiss: () => {
        if (get().phase === "done") set({ phase: "idle", tab: null, result: null });
      },
      deleteResult: async () => {
        const { result } = get();
        if (!result) return;
        await ipc.recordingDelete(result.path);
        set({ phase: "idle", tab: null, result: null });
      },
    }),
    {
      name: "dive.recording",
      storage: createJSONStorage(() => uiStorage),
      version: 2,
      partialize: (s) => ({ settings: s.settings }),
      merge: (persisted, current) => ({ ...current, settings: { ...DEFAULT_SETTINGS, ...((persisted as Partial<RecordingState> | undefined)?.settings ?? {}) } }),
    },
  ),
);

/** Apply one of the engine's recording events. Exported for tests. */
export function applyRecordingEvent(event: RecordingEvent) {
  const { tab, phase } = useRecording.getState();
  if (event.tab !== tab) return;
  const set = useRecording.setState;
  switch (event.kind) {
    case "limit":
      if (phase === "recording" || phase === "paused") {
        set({ limitHit: true });
        void useRecording.getState().stop();
      }
      return;
    case "mic_failed":
      set({ micFailed: true });
      return;
    case "progress":
      if (phase === "finishing" && event.progress !== null) set({ progress: event.progress });
      return;
    // The engine began saving on its own: the tab closed, or Dive is quitting.
    case "finishing":
      if (phase === "recording" || phase === "paused" || phase === "failed") set({ phase: "finishing", progress: null, error: null });
      return;
    case "saved":
      if (event.result && (phase === "finishing" || phase === "recording" || phase === "paused" || phase === "failed")) {
        useBrowser.setState({ recordingTab: null });
        set({ phase: "done", result: event.result, error: null, progress: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
      }
      return;
    case "failed":
      if (phase === "finishing" || phase === "recording" || phase === "paused") set({ phase: "failed", progress: null, error: event.error ?? "Recording could not be saved" });
      return;
  }
}

/**
 * The recorded tab closed. Before capture began there is nothing to keep;
 * after, the engine saves the recording and its events say how that went.
 * A save already under way, a failed one and a finished file are unaffected:
 * a save used to be announced as "discarded" and then turn up saved anyway.
 * Exported for tests.
 */
export function recordedTabClosed(id: string) {
  const { tab, phase } = useRecording.getState();
  if (id !== tab) return;
  if (phase === "setup" || phase === "starting" || phase === "countdown") {
    window.clearTimeout(countdownTimer);
    useRecording.setState({ phase: "idle", tab: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
    useBrowser.setState({ recordingTab: null, error: "The tab to record was closed before recording began" });
  } else if (phase === "recording" || phase === "paused") {
    useRecording.setState({ phase: "finishing", progress: null, error: null });
  }
}

/** Wire engine events once: the length cap ends the recording on its own,
 * a save the engine began itself reports back, and a tab closing under a
 * recording saves it. */
function listen() {
  if (listening) return;
  listening = true;
  // Outside Tauri (tests) there is no event bridge; the recorder still works
  // without these signals.
  void events.recordingEvent.listen((e) => applyRecordingEvent(e.payload)).catch(() => undefined);
  // The engine's own close event, not the tab list: that list holds the
  // active workspace only, and switching workspaces used to count as the
  // recorded tab closing.
  void events.stateChanged.listen((e) => {
    if (e.payload.type === "tab_closed") recordedTabClosed(e.payload.data);
  }).catch(() => undefined);
}
