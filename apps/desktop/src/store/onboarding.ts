import { create } from "zustand";
import { usePrefs } from "./prefs";

/**
 * The first-run flow, in order. `intro` is the five-second brand sting,
 * `start` the screen with the one button, then the setup steps, then the
 * welcome screen takes over. `null` means the flow is not showing.
 */
export const STAGES = ["intro", "start", "profile", "theme", "import", "workspace", "features"] as const;
export type Stage = (typeof STAGES)[number];

/** The setup steps a person can move back and forth between. */
export const STEPS = ["profile", "theme", "import", "workspace", "features"] as const satisfies readonly Stage[];

interface OnboardingState {
  stage: Stage | null;
  /** Show the flow from the intro. */
  begin: () => void;
  /** Jump past the intro to the start screen. */
  skipIntro: () => void;
  /** Advance one stage; from the last step, finish. */
  next: () => void;
  /** Go back one setup step; nothing happens on the first. */
  back: () => void;
  /** Record the flow as done and hide it. */
  finish: () => Promise<void>;
  /** Forget that the flow was done and show it again from the intro. */
  replay: () => Promise<void>;
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  stage: null,
  begin: () => set({ stage: "intro" }),
  skipIntro: () => set((s) => (s.stage === "intro" ? { stage: "start" } : s)),
  next: () => {
    const { stage } = get();
    if (stage === null) return;
    const at = STAGES.indexOf(stage);
    const following = STAGES[at + 1];
    if (following) set({ stage: following });
    else void get().finish();
  },
  back: () => {
    const { stage } = get();
    const at = STEPS.indexOf(stage as (typeof STEPS)[number]);
    if (at > 0) set({ stage: STEPS[at - 1]! });
  },
  finish: async () => {
    set({ stage: null });
    await usePrefs.getState().update({ onboarded: true });
  },
  replay: async () => {
    await usePrefs.getState().update({ onboarded: false });
    set({ stage: "intro" });
  },
}));

/**
 * Whether the flow should open on its own: the preferences have loaded and
 * say it was never completed, and this is not a private window (whose
 * in-memory profile is always fresh, and which must never ask anyone to
 * set up a profile). Pure, so the gate is testable.
 */
export function shouldOnboard(loaded: boolean, onboarded: boolean, ready: boolean, privateWindow = false): boolean {
  return loaded && ready && !onboarded && !privateWindow;
}
