import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { uiStorage } from "../lib/uiStorage";

/**
 * Whether the Connect button still needs to catch the eye.
 *
 * It is the one control in the bar nobody goes looking for: you cannot want
 * to point your agent at this browser until you know that you can. So it
 * shimmers -- and stops for good the first time it is opened, because a hint
 * that keeps hinting after it has been taken is just a bar that moves.
 */
interface ConnectHintState {
  /** Whether the dialog has ever been opened on this machine. */
  seen: boolean;
  /** Note that the person has opened it. */
  markSeen: () => void;
  /** Forget, for tests. */
  reset: () => void;
}

export const useConnectHint = create<ConnectHintState>()(
  persist(
    (set) => ({
      seen: false,
      markSeen: () => set({ seen: true }),
      reset: () => set({ seen: false }),
    }),
    { name: "dive.connectHint", storage: createJSONStorage(() => uiStorage), version: 1 },
  ),
);
