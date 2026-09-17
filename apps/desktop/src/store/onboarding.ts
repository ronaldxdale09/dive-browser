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
export type Step = (typeof STEPS)[number];

function isStep(stage: Stage | null): stage is Step {
  return stage !== null && (STEPS as readonly string[]).includes(stage);
}

interface OnboardingState {
  stage: Stage | null;
  /** Setup steps left without writing anything. */
  skipped: Step[];
  /** Show the flow from the intro. */
  begin: () => void;
  /** Jump past the intro to the start screen. */
  skipIntro: () => void;
  /** Advance one stage; from the last step, finish. */
  next: () => void;
  /** Leave the current setup step without writing, and advance. */
  skip: () => void;
  /** Go back one setup step; nothing happens on the first. */
  back: () => void;
  /** Record the flow as done and hide it. */
  finish: () => Promise<void>;
  /** Forget that the flow was done and show it again from the intro. */
  replay: () => Promise<void>;
}

function leave(get: () => OnboardingState, set: (partial: Partial<OnboardingState>) => void, how: "next" | "skip") {
  const { stage, skipped } = get();
  if (stage === null) return;
  let nextSkipped = skipped;
  if (isStep(stage)) {
    nextSkipped = how === "skip" ? (skipped.includes(stage) ? skipped : [...skipped, stage]) : skipped.filter((step) => step !== stage);
  }
  const following = STAGES[STAGES.indexOf(stage) + 1];
  if (following) set({ stage: following, skipped: nextSkipped });
  else void get().finish();
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  stage: null,
  skipped: [],
  begin: () => set({ stage: "intro", skipped: [] }),
  skipIntro: () => set((s) => (s.stage === "intro" ? { stage: "start" } : s)),
  next: () => leave(get, set, "next"),
  skip: () => leave(get, set, "skip"),
  back: () => {
    const { stage } = get();
    const at = STEPS.indexOf(stage as Step);
    if (at > 0) set({ stage: STEPS[at - 1]! });
  },
  finish: async () => {
    set({ stage: null, skipped: [] });
    await usePrefs.getState().update({ onboarded: true });
  },
  replay: async () => {
    await usePrefs.getState().update({ onboarded: false });
    set({ stage: "intro", skipped: [] });
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
