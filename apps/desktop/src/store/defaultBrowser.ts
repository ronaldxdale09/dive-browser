import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { DefaultBrowserStatus } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { isWindows } from "../lib/commands";

/**
 * Where the "make Dive the default" flow stands. `asking` while the host is
 * being told to ask; `waiting` while macOS shows its own confirmation and we
 * poll for the answer; `done` once Dive handles links.
 */
export type DefaultBrowserPhase = "idle" | "asking" | "waiting" | "done" | "error";

/** How long to poll for macOS's own confirmation before saying where else to set it. */
export const WAIT_TIMEOUT_MS = 20_000;
/**
 * Windows has no confirmation to click: Settings opens and the person has to
 * find Dive in a list, which takes longer than answering a dialog.
 */
export const WINDOWS_WAIT_TIMEOUT_MS = 90_000;
/** How often to re-ask the host while waiting. */
export const POLL_INTERVAL_MS = 1_000;

/** How long a "Not now" rests the rail's offer. Settings › General offers it meanwhile. */
export const DECLINE_REST_MS = 14 * 24 * 60 * 60 * 1000;
const DECLINED_KEY = "dive.defaultBrowser.declinedUntil";

/** Whether a stored "Not now" is still in force at `now`. */
export function declinedAt(now: number, stored: string | null | undefined): boolean {
  const until = Number(stored);
  return Number.isFinite(until) && until > now;
}

function readDeclined(): boolean {
  try {
    return declinedAt(Date.now(), localStorage.getItem(DECLINED_KEY));
  } catch {
    return false;
  }
}

function writeDeclined(until: number) {
  try {
    localStorage.setItem(DECLINED_KEY, String(until));
  } catch {
    // Storage unavailable: the decline still holds for this session.
  }
}

interface DefaultBrowserState {
  status: DefaultBrowserStatus | null;
  phase: DefaultBrowserPhase;
  error: string | null;
  /** Still waiting, but past the time a confirmation takes: say where to set it by hand. */
  timedOut: boolean;
  /** "Not now" was chosen recently: the rail stops offering for a couple of weeks. */
  declined: boolean;
  decline: () => void;
  /** Re-read the status from the host. Returns it, or null when the host cannot say. */
  refresh: () => Promise<DefaultBrowserStatus | null>;
  /** Ask the system to make Dive the default; phase and error follow the result. */
  makeDefault: () => Promise<DefaultBrowserStatus | null>;
  reset: () => void;
}

let poll: ReturnType<typeof setInterval> | null = null;
let onFocus: (() => void) | null = null;

function stopWatching() {
  if (poll) clearInterval(poll);
  poll = null;
  if (onFocus) window.removeEventListener("focus", onFocus);
  onFocus = null;
}

/**
 * Follow the system's answer after asking, wherever the asking was done.
 *
 * The polling used to live in the dialog, so the same button in setup never
 * learnt the answer and said "macOS is asking you to confirm" for good. The
 * status is read every second until the wait runs out, and again whenever
 * Dive's window comes back to the front: that is when someone returns from
 * the system's settings, however long they took there.
 */
function watch(set: (patch: Partial<DefaultBrowserState>) => void, get: () => DefaultBrowserState) {
  stopWatching();
  const started = Date.now();
  const timeout = isWindows() ? WINDOWS_WAIT_TIMEOUT_MS : WAIT_TIMEOUT_MS;
  const check = async () => {
    const status = await get().refresh();
    // A reset, a new ask or an error moved on without us.
    if (get().phase !== "waiting") {
      stopWatching();
      return;
    }
    if (status?.is_default) {
      set({ phase: "done", timedOut: false });
      stopWatching();
    } else if (poll && Date.now() - started >= timeout) {
      clearInterval(poll);
      poll = null;
      set({ timedOut: true });
    }
  };
  poll = setInterval(() => void check(), POLL_INTERVAL_MS);
  onFocus = () => void check();
  window.addEventListener("focus", onFocus);
}

export const useDefaultBrowser = create<DefaultBrowserState>((set, get) => ({
  status: null,
  phase: "idle",
  error: null,
  timedOut: false,
  declined: readDeclined(),
  decline: () => {
    writeDeclined(Date.now() + DECLINE_REST_MS);
    set({ declined: true });
  },
  refresh: async () => {
    try {
      const status = await ipc.defaultBrowserStatus();
      set({ status });
      return status;
    } catch {
      return null;
    }
  },
  makeDefault: async () => {
    stopWatching();
    set({ phase: "asking", error: null, timedOut: false });
    try {
      const status = await ipc.defaultBrowserSet();
      set({ status, phase: status.is_default ? "done" : "waiting" });
      if (!status.is_default) watch(set, get);
      return status;
    } catch (e) {
      set({ phase: "error", error: errorMessage(e) });
      return null;
    }
  },
  reset: () => {
    stopWatching();
    set({ phase: "idle", error: null, timedOut: false });
  },
}));
