import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useBrowser } from "../store/browser";
import { useCoversContent } from "../lib/overlay";
import { scheduleControlsReady } from "../lib/startup";

const OrbBurst = lazy(() => import("./OrbBurst").then(({ OrbBurst }) => ({ default: OrbBurst })));

/** A fast boot never paints a splash at all. */
export const SPLASH_DELAY_MS = 160;
/** Once shown, stay long enough to read as intentional rather than a flash. */
export const SPLASH_MIN_VISIBLE_MS = 180;
/** Fast compositor-only exit. */
export const SPLASH_FADE_MS = 160;

/**
 * Full-window loading cover shown until the store has its first snapshot back
 * from the backend. It sits above the chrome but the app renders underneath it,
 * so layout (and the content-bounds report) settles while it is still up.
 */
export function Splash() {
  const ready = useBrowser((s) => s.ready);
  const error = useBrowser((s) => s.error);
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const shownAt = useRef(0);
  const initializationFailed = useRef(false);
  useCoversContent(visible && !gone);

  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => {
      shownAt.current = Date.now();
      setVisible(true);
    }, SPLASH_DELAY_MS);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (!ready || !visible) return;
    const hold = Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - shownAt.current));
    let fade: ReturnType<typeof setTimeout> | undefined;
    const leave = setTimeout(() => {
      setLeaving(true);
      fade = setTimeout(() => setGone(true), SPLASH_FADE_MS);
    }, hold);
    return () => {
      clearTimeout(leave);
      if (fade) clearTimeout(fade);
    };
  }, [ready, visible]);

  useEffect(() => {
    // The store also sets ready on initialization failure. Only a successful
    // snapshot, with the splash entirely absent, qualifies as usable controls.
    if (ready && error !== null) initializationFailed.current = true;
    if (ready && !initializationFailed.current && (gone || !visible)) return scheduleControlsReady();
  }, [ready, error, gone, visible]);

  if (gone || (ready && !visible)) return null;

  return (
    <div
      aria-hidden
      className="fixed inset-0 z-50 grid place-items-center bg-ground transition-opacity duration-150 ease-out"
      style={{ opacity: visible && !leaving ? 1 : 0, pointerEvents: visible && !leaving ? "auto" : "none" }}
    >
      {visible && <div className="flex flex-col items-center">
        <Suspense fallback={<div className="size-[260px]" aria-hidden />}>
          <OrbBurst width={260} height={260} pointer={{ drag: 0 }} />
        </Suspense>
        <p className="-mt-2 text-base font-semibold tracking-tight">Dive</p>
        <p className="mt-1 font-mono text-[11px] tracking-[0.14em] text-ink-3 uppercase">
          Starting engine
        </p>
      </div>}
    </div>
  );
}
