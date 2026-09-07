import { useEffect, useRef } from "react";
import { useOnboarding } from "../../store/onboarding";
import { Backdrop } from "./Backdrop";

/**
 * One button on the welcome ground. The mark sits where the intro left it,
 * so the hand-over reads as the same scene coming to rest, and the button's
 * border carries the only motion on screen. While the intro plays this
 * screen is already mounted underneath it (`behind`), inert, so the intro's
 * fade lands on it and never on the page below.
 */
export function StartScreen({ behind = false }: { behind?: boolean }) {
  const next = useOnboarding((s) => s.next);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!behind) button.current?.focus({ preventScroll: true });
  }, [behind]);
  return (
    <div role="dialog" aria-label="Start Dive" inert={behind || undefined} className="fixed inset-0 z-[60] bg-ground text-ink">
      <Backdrop orb={300} />
      {/* The copy starts under the mark, which the backdrop centres at 40% of the height. */}
      <div className="absolute inset-x-0 top-[calc(40%+150px)] z-10 flex flex-col items-center px-6">
        <p className="font-mono text-[11px] tracking-[0.24em] text-highlight uppercase">Dive</p>
        <h1 className="mt-3 text-center text-[clamp(28px,4vw,40px)] leading-tight font-semibold tracking-[-0.03em] text-balance">
          The browser built for developers
        </h1>
        <p className="mt-3 max-w-[460px] text-center text-[13.5px] leading-relaxed text-ink-2 text-balance">
          A minute of setup: who you are, where you work, and what is waiting inside.
        </p>
        <button ref={button} type="button" onClick={next} className="start-button pressable mt-9">
          <span className="start-button-face">
            Start Dive
            <kbd className="ml-3 rounded-md bg-ground/25 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em]">↵</kbd>
          </span>
        </button>
      </div>
    </div>
  );
}
