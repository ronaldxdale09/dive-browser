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
    set({ status: "checking", error: null });
    try {
      const update = await ipc.updateCheck();
      set(update ? { status: "available", update, dismissed: false } : { status: "none", update: null, dismissed: false });
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
      set({ installing: false, error: errorMessage(e) });
    }
  },
  dismiss: () => set({ dismissed: true }),
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

/** Delay before the one automatic check after launch, so it never competes with startup. */
export const BOOT_CHECK_DELAY_MS = 10_000;

let bootTimer: ReturnType<typeof setTimeout> | null = null;
let bootScheduled = false;

/**
 * Check once, a while after boot. Idempotent: a remount of the chrome does not
 * schedule a second check. Returns a cancel for the caller's cleanup; a
 * cancelled check stays "scheduled" only until the cancel runs.
 */
export function scheduleBootCheck(delay = BOOT_CHECK_DELAY_MS): () => void {
  if (bootScheduled) return () => undefined;
  bootScheduled = true;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void useUpdates.getState().check();
  }, delay);
  return () => {
    if (bootTimer) {
      clearTimeout(bootTimer);
      bootTimer = null;
      bootScheduled = false;
    }
  };
}

/** Tests only. */
export function resetBootCheck() {
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
  bootScheduled = false;
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = null;
  progressPending = null;
  progressAt = 0;
}
