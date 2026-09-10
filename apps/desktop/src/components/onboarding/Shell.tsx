import type { ReactNode } from "react";
import { STEPS, useOnboarding } from "../../store/onboarding";
import { Backdrop } from "./Backdrop";

const TITLES: Record<(typeof STEPS)[number], string> = {
  profile: "Profile",
  theme: "Theme",
  import: "Import",
  workspace: "Workspace",
  features: "What's inside",
};

/** "Step 2 of 4", from the step order, so a new step never miscounts the others. */
export function stepLabel(step: (typeof STEPS)[number]): string {
  return `Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`;
}

/**
 * The frame every setup step sits in: the welcome ground behind, a step
 * rail on top, and a card in the middle whose contents change. The card is
 * keyed by stage so each step arrives with its own entrance.
 */
export function Shell({ children }: { children: ReactNode }) {
  const stage = useOnboarding((s) => s.stage);
  const at = STEPS.indexOf(stage as (typeof STEPS)[number]);
  return (
    <div role="dialog" aria-label="Set up Dive" className="fixed inset-0 z-[60] bg-ground text-ink">
      <Backdrop />
      <div className="relative z-10 flex h-full flex-col">
        <ol aria-label="Setup steps" className="flex shrink-0 items-center justify-center gap-6 pt-7">
          {STEPS.map((step, i) => {
            const state = i < at ? "done" : i === at ? "current" : "todo";
            return (
              <li key={step} aria-current={state === "current" ? "step" : undefined} data-state={state} className="onboarding-step flex items-center gap-2 font-mono text-[10.5px] tracking-[0.16em] uppercase">
                <span className="onboarding-step-dot grid size-5 place-items-center rounded-full border text-[9px]">{i + 1}</span>
                {TITLES[step]}
              </li>
            );
          })}
        </ol>
        {/* The card centres when it fits and scrolls when the window is short:
            `my-auto` inside a scrolling column does both without measuring. */}
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-6">
          <div key={stage} className="onboarding-enter my-auto w-[560px] max-w-full shrink-0 rounded-3xl border border-line-2 bg-surface/85 p-6 shadow-2xl backdrop-blur-xl sm:p-7">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared footer: back on the left when there is somewhere to go, the primary on the right. */
export function StepActions({ primary, disabled = false, onPrimary, skip }: { primary: string; disabled?: boolean; onPrimary: () => void; skip?: (() => void) | undefined }) {
  const back = useOnboarding((s) => s.back);
  const stage = useOnboarding((s) => s.stage);
  const first = stage === STEPS[0];
  return (
    <div className="mt-6 flex items-center gap-2">
      {!first && (
        <button type="button" onClick={back} className="pressable h-9 rounded-full px-3.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
          Back
        </button>
      )}
      <span className="flex-1" />
      {skip && (
        <button type="button" onClick={skip} className="pressable h-9 rounded-full px-3.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink">
          Skip
        </button>
      )}
      <button type="button" disabled={disabled} onClick={onPrimary} className="pressable h-9 rounded-full bg-accent px-5 text-xs font-medium text-accent-ink hover:brightness-110 disabled:opacity-40">
        {primary}
      </button>
    </div>
  );
}
