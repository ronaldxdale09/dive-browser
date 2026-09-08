import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { DefaultBrowserStatus } from "../lib/ipc";
import { errorMessage } from "../lib/errors";

/**
 * Where the "make Dive the default" flow stands. `asking` while the host is
 * being told to ask; `waiting` while macOS shows its own confirmation and we
 * poll for the answer; `done` once Dive handles links.
 */
export type DefaultBrowserPhase = "idle" | "asking" | "waiting" | "done" | "error";

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
  /** "Not now" was chosen recently: the rail stops offering for a couple of weeks. */
  declined: boolean;
  decline: () => void;
  /** Re-read the status from the host. Returns it, or null when the host cannot say. */
  refresh: () => Promise<DefaultBrowserStatus | null>;
  /** Ask the system to make Dive the default; phase and error follow the result. */
  makeDefault: () => Promise<DefaultBrowserStatus | null>;
  reset: () => void;
}

export const useDefaultBrowser = create<DefaultBrowserState>((set) => ({
  status: null,
  phase: "idle",
  error: null,
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
    set({ phase: "asking", error: null });
    try {
      const status = await ipc.defaultBrowserSet();
      set({ status, phase: status.is_default ? "done" : "waiting" });
      return status;
    } catch (e) {
      set({ phase: "error", error: errorMessage(e) });
      return null;
    }
  },
  reset: () => set({ phase: "idle", error: null }),
}));
