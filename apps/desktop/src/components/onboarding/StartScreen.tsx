import { lazy, Suspense, useEffect, useRef, useSyncExternalStore } from "react";
import { useOnboarding } from "../../store/onboarding";
import { Backdrop } from "./Backdrop";

const OrbBurst = lazy(() => import("../OrbBurst").then(({ OrbBurst }) => ({ default: OrbBurst })));

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The orb's box: a third of the window's height, within the sizes that read well. */
export function orbSize(height: number): number {
  return Math.round(Math.min(300, Math.max(180, height * 0.36)));
}

/**
 * One button on the welcome ground. The mark sits where the intro left it,
 * so the hand-over reads as the same scene coming to rest, and the button's
 * border carries the only motion on screen. While the intro plays this
 * screen is already mounted underneath it (`behind`), inert, so the intro's
 * fade lands on it and never on the page below. The column is laid out in
 * flow and the orb sized from the window, so a short window still shows
 * the button.
 */
export function StartScreen({ behind = false }: { behind?: boolean }) {
  const next = useOnboarding((s) => s.next);
  const button = useRef<HTMLButtonElement>(null);
  const orb = useSyncExternalStore(subscribe, () => orbSize(window.innerHeight), () => 300);
  useEffect(() => {
    if (!behind) button.current?.focus({ preventScroll: true });
  }, [behind]);
  return (
    <div role="dialog" aria-label="Start Dive" inert={behind || undefined} className="fixed inset-0 z-[60] bg-ground text-ink">
      <Backdrop />
      <div className="relative z-10 flex h-full flex-col items-center justify-center overflow-hidden px-6">
        <div className="-mb-3" style={{ width: orb, height: orb }} aria-hidden>
          <Suspense fallback={null}>
            <OrbBurst width={orb} height={orb} pointer={{ drag: 0 }} />
          </Suspense>
        </div>
        <p className="font-mono text-[11px] tracking-[0.24em] text-highlight uppercase">Dive</p>
        <h1 className="mt-3 text-center text-[clamp(26px,4vw,40px)] leading-tight font-semibold tracking-[-0.03em] text-balance">
          The browser built for developers
        </h1>
        <p className="mt-3 max-w-[460px] text-center text-[13.5px] leading-relaxed text-ink-2 text-balance">
          A minute of setup: who you are, where you work, and what is waiting inside.
        </p>
        <button ref={button} type="button" onClick={next} className="start-button pressable mt-8">
          <span className="start-button-face">
            Start Dive
            <kbd className="ml-3 rounded-md bg-ground/25 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em]">↵</kbd>
          </span>
        </button>
      </div>
    </div>
  );
}
