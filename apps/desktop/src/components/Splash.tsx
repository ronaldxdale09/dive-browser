import { useEffect, useState } from "react";
import { OrbBurst } from "./OrbBurst";
import { useBrowser } from "../store/browser";
import { useCoversContent } from "../lib/overlay";

/** Shortest time the splash stays up, so a fast boot doesn't flash it. */
const MIN_MS = 900;
/** Length of the fade-out; must match the transition duration below. */
const FADE_MS = 420;

/**
 * Full-window loading cover shown until the store has its first snapshot back
 * from the backend. It sits above the chrome but the app renders underneath it,
 * so layout (and the content-bounds report) settles while it is still up.
 */
export function Splash() {
  const ready = useBrowser((s) => s.ready);
  const [held, setHeld] = useState(true);
  const [gone, setGone] = useState(false);
  useCoversContent(!gone);

  useEffect(() => {
    const t = setTimeout(() => setHeld(false), MIN_MS);
    return () => clearTimeout(t);
  }, []);

  const leaving = ready && !held;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  if (gone) return null;

  return (
    <div
      aria-hidden
      className="fixed inset-0 z-50 grid place-items-center bg-ground transition-opacity duration-[420ms] ease-out"
      style={{ opacity: leaving ? 0 : 1 }}
    >
      <div className="flex flex-col items-center">
        <OrbBurst width={260} height={260} pointer={{ drag: 0 }} />
        <p className="-mt-2 text-base font-semibold tracking-tight">Dive</p>
        <p className="mt-1 font-mono text-[11px] tracking-[0.14em] text-ink-3 uppercase">
          Starting engine
        </p>
      </div>
    </div>
  );
}
