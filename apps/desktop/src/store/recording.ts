import { create } from "zustand";
import { persist } from "zustand/middleware";
import { events, ipc } from "../lib/ipc";
import type { RecordingCapabilities, RecordingResult } from "../lib/ipc";
import { useBrowser } from "./browser";

/**
 * Screen recording, start to finish: the setup dialog, a countdown, the
 * recording itself with pause and resume, and the finished file. One
 * recording at a time; the settings are remembered between recordings.
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

export type Phase = "idle" | "setup" | "countdown" | "recording" | "paused" | "finishing" | "done";

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
  result: RecordingResult | null;
  error: string | null;

  loadCaps: () => Promise<void>;
  /** Open the setup dialog, aimed at `tab` or the active tab. */
  openSetup: (tab?: string | null) => void;
  closeSetup: () => void;
  setTab: (tab: string) => void;
  setSettings: (patch: Partial<RecordSettings>) => void;
  /** ⌘⇧R: open setup when idle, stop when recording. */
  toggle: () => Promise<void>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
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
      result: null,
      error: null,

      loadCaps: async () => {
        try {
          set({ caps: await ipc.recordingCapabilities() });
        } catch (e) {
          set({ caps: { ffmpeg: false, microphones: [], video_max_seconds: 600, gif_max_seconds: 60 }, error: String(e) });
        }
      },

      openSetup: (tab) => {
        const { phase } = get();
        if (phase !== "idle" && phase !== "done") return;
        const target = tab ?? useBrowser.getState().activeTab;
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
        if (phase === "recording" || phase === "paused") await get().stop();
        else if (phase === "countdown") await get().cancel();
        else get().openSetup();
      },

      start: async () => {
        const { tab, phase } = get();
        if (!tab || phase !== "setup") return;
        const settings = effectiveSettings(get().settings, get().caps);
        set({ settings });
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
        try {
          await ipc.tabScreencastStart(tab, { source: settings.source, format: settings.format, fps: settings.fps, max_width: settings.width, microphone: settings.microphone });
          set({ phase: "recording", startedAt: Date.now(), pausedAt: null, pausedTotal: 0, limitHit: false, error: null });
          useBrowser.setState({ recordingTab: tab });
        } catch (e) {
          set({ phase: "setup", error: e instanceof Error ? e.message : String(e) });
        }
      },

      pause: async () => {
        const { tab, phase } = get();
        if (!tab || phase !== "recording") return;
        await ipc.tabScreencastPause(tab, true).catch(() => undefined);
        set({ phase: "paused", pausedAt: Date.now() });
      },
      resume: async () => {
        const { tab, phase, pausedAt, pausedTotal } = get();
        if (!tab || phase !== "paused") return;
        await ipc.tabScreencastPause(tab, false).catch(() => undefined);
        set({ phase: "recording", pausedAt: null, pausedTotal: pausedTotal + (pausedAt === null ? 0 : Date.now() - pausedAt) });
      },

      stop: async () => {
        const { tab, phase } = get();
        if (!tab || (phase !== "recording" && phase !== "paused")) return;
        set({ phase: "finishing" });
        useBrowser.setState({ recordingTab: null });
        try {
          const result = await ipc.tabScreencastStop(tab);
          set({ phase: "done", result, error: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
        } catch (e) {
          set({ phase: "idle", tab: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
          useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
        }
      },

      cancel: async () => {
        const { tab, phase } = get();
        window.clearTimeout(countdownTimer);
        if (tab && (phase === "recording" || phase === "paused")) await ipc.tabScreencastCancel(tab).catch(() => undefined);
        useBrowser.setState({ recordingTab: null });
        set({ phase: "idle", tab: null, startedAt: null, pausedAt: null, pausedTotal: 0, countdown: 0 });
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
      version: 2,
      partialize: (s) => ({ settings: s.settings }),
      merge: (persisted, current) => ({ ...current, settings: { ...DEFAULT_SETTINGS, ...((persisted as Partial<RecordingState> | undefined)?.settings ?? {}) } }),
    },
  ),
);

/** Wire engine events once: the length cap ends the recording on its own,
 * and a tab closing under a recording discards it. */
function listen() {
  if (listening) return;
  listening = true;
  // Outside Tauri (tests) there is no event bridge; the recorder still works
  // without the length-cap signal.
  void events.recordingEvent.listen((e) => {
    const { tab, phase } = useRecording.getState();
    if (e.payload.kind === "limit" && e.payload.tab === tab && (phase === "recording" || phase === "paused")) {
      useRecording.setState({ limitHit: true });
      void useRecording.getState().stop();
    }
  }).catch(() => undefined);
  useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    const { tab, phase } = useRecording.getState();
    if (!tab || phase === "idle" || phase === "done") return;
    if (!s.tabs.some((t) => t.id === tab)) {
      window.clearTimeout(countdownTimer);
      useRecording.setState({ phase: "idle", tab: null, startedAt: null, pausedAt: null, pausedTotal: 0 });
      useBrowser.setState({ recordingTab: null, error: "The tab being recorded was closed, so the recording was discarded" });
    }
  });
}
