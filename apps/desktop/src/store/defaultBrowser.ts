import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { DefaultBrowserStatus } from "../lib/ipc";

/**
 * Where the "make Dive the default" flow stands. `asking` while the host is
 * being told to ask; `waiting` while macOS shows its own confirmation and we
 * poll for the answer; `done` once Dive handles links.
 */
export type DefaultBrowserPhase = "idle" | "asking" | "waiting" | "done" | "error";

interface DefaultBrowserState {
  status: DefaultBrowserStatus | null;
  phase: DefaultBrowserPhase;
  error: string | null;
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
      set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },
  reset: () => set({ phase: "idle", error: null }),
}));
