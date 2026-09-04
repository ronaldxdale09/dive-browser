import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { UpdateInfo } from "../lib/ipc";

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
  dismissed: false,
  check: async () => {
    if (get().status === "checking") return;
    set({ status: "checking", error: null });
    try {
      const update = await ipc.updateCheck();
      set(update ? { status: "available", update, dismissed: false } : { status: "none", update: null, dismissed: false });
    } catch (e) {
      set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  },
  install: async () => {
    if (get().installing) return;
    set({ installing: true, error: null });
    try {
      await ipc.updateInstall();
    } catch (e) {
      set({ installing: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  dismiss: () => set({ dismissed: true }),
  reopen: () => set({ dismissed: false }),
}));

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
}
