import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { UpdateInfo } from "../lib/ipc";
import { errorMessage } from "../lib/errors";

/**
 * Where the last update check landed. `idle` before any check; `none` when the
 * release channel had nothing newer -- or when this build has no updater at
 * all, which the host reports the same way.
 */
export type UpdateStatus = "idle" | "checking" | "none" | "available" | "error";

interface UpdatesState {
  status: UpdateStatus;
  update: UpdateInfo | null;
  error: string | null;
  installing: boolean;
  /** Bytes of the update downloaded so far, while it is downloading. */
  received: number;
  /** Its total size, when the release declared one. */
  total: number | null;
  /** The download is done and the installer is running. */
  applying: boolean;
  dismissed: boolean;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
  reopen: () => void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: "idle",
  update: null,
  error: null,
  installing: false,
  received: 0,
  total: null,
  applying: false,
  dismissed: false,
  check: async () => {
    if (get().status === "checking") return;
    lastCheckAt = Date.now();
    set({ status: "checking", error: null });
    try {
      const update = await ipc.updateCheck();
      if (!update) {
        set({ status: "none", update: null, dismissed: false });
        return;
      }
      // A later check that finds the same release must not put a notice the
      // person has already waved away back on screen; a newer one may.
      const sameAsDismissed = get().dismissed && get().update?.version === update.version;
      set({ status: "available", update, dismissed: sameAsDismissed });
    } catch (e) {
      set({ status: "error", error: errorMessage(e) });
    }
  },
  install: async () => {
    if (get().installing) return;
    set({ installing: true, error: null, received: 0, total: null, applying: false });
    try {
      await ipc.updateInstall();
    } catch (e) {
      // Back on screen with the reason: an install started from Settings, or
      // from a card waved away earlier, otherwise failed where no one looked.
      set({ installing: false, error: errorMessage(e), dismissed: false });
    }
  },
  dismiss: () => {
    if (get().installing) return;
    set({ dismissed: true });
  },
  reopen: () => set({ dismissed: false }),
}));

let listening = false;

/** How often the dialog is told about the download; a chunk lands far more often than that. */
export const PROGRESS_INTERVAL_MS = 200;
let progressAt = 0;
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let progressPending: { received: number; total: number | null } | null = null;

/**
 * Fold one progress report into the store, at most one write per interval.
 *
 * The updater reports every chunk it writes, and a fast download re-rendered
 * the dialog hundreds of times a second. A report that arrives too soon
 * waits for the interval to lapse and is then applied -- the latest one, so
 * the bar never sits on a stale count -- and the end of the download goes
 * through at once. Exported for tests.
 */
export function reportUpdateProgress(payload: { received: number | null; total: number | null; done: boolean }, now = Date.now()) {
  if (payload.done) {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    progressPending = null;
    useUpdates.setState({ applying: true });
    return;
  }
  progressPending = { received: payload.received ?? 0, total: payload.total ?? null };
  if (progressTimer) return;
  const wait = PROGRESS_INTERVAL_MS - (now - progressAt);
  const apply = () => {
    progressTimer = null;
    if (!progressPending) return;
    progressAt = Date.now();
    useUpdates.setState({ ...progressPending, applying: false });
    progressPending = null;
  };
  if (wait <= 0) apply();
  else progressTimer = setTimeout(apply, wait);
}

/** Follow the update download; without this the dialog said "Installing..." for its whole length. */
export function listenForUpdateProgress() {
  if (listening) return;
  listening = true;
  void events
    .updateProgress.listen((e) => reportUpdateProgress(e.payload))
    .catch(() => undefined);
}

/** Delay before the first automatic check after launch, so it never competes with startup. */
export const BOOT_CHECK_DELAY_MS = 10_000;
/** How often the release channel is looked at while the browser stays open. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** No two automatic checks closer together than this, however they were asked for. */
export const MIN_CHECK_GAP_MS = 15 * 60 * 1000;

let bootTimer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let watching = false;
let lastCheckAt = 0;
let onWake: (() => void) | null = null;

/**
 * Check when it is worth checking: not while one is in flight, not while an
 * update is being installed, and never twice inside [`MIN_CHECK_GAP_MS`].
 * Exported for tests.
 */
export function maybeCheck() {
  const { status, installing } = useUpdates.getState();
  if (status === "checking" || installing) return;
  if (lastCheckAt && Date.now() - lastCheckAt < MIN_CHECK_GAP_MS) return;
  void useUpdates.getState().check();
}

/**
 * Watch the release channel for as long as this chrome is up: once shortly
 * after boot, then every [`CHECK_INTERVAL_MS`].
 *
 * A browser people leave open for days used to learn about a release only
 * when it was next started, so the notice appeared to need a restart. Waking
 * from sleep and coming back online check too: an interval does not fire
 * while the machine is asleep, and the boot check of a laptop opened away
 * from a network finds nothing and would otherwise wait the whole interval.
 *
 * Idempotent: a remount of the chrome does not start a second watch. Returns
 * a cancel for the caller's cleanup.
 */
export function startUpdateWatch(delay = BOOT_CHECK_DELAY_MS): () => void {
  if (watching) return () => undefined;
  watching = true;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    maybeCheck();
  }, delay);
  interval = setInterval(maybeCheck, CHECK_INTERVAL_MS);
  onWake = () => maybeCheck();
  window.addEventListener("focus", onWake);
  window.addEventListener("online", onWake);
  return stopUpdateWatch;
}

function stopUpdateWatch() {
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
  if (interval) clearInterval(interval);
  interval = null;
  if (onWake) {
    window.removeEventListener("focus", onWake);
    window.removeEventListener("online", onWake);
    onWake = null;
  }
  watching = false;
}

/** Tests only. */
export function resetBootCheck() {
  stopUpdateWatch();
  lastCheckAt = 0;
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = null;
  progressPending = null;
  progressAt = 0;
}
