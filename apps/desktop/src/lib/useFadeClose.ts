import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./useReducedMotion";

/** Length of a dialog's fade, in ms; matches `--dialog-fade` in styles.css. */
export const DIALOG_FADE_MS = 120;

/**
 * A dialog that fades out before it goes.
 *
 * Dialogs over the page hide the native view for as long as they are mounted
 * (see lib/overlay.ts), so unmounting on close is what releases the page.
 * That must stay synchronous with the dialog leaving the screen -- release
 * it early and the page paints over a dialog that is still fading -- so the
 * fade runs first and `onClosed` (which unmounts) runs when it ends. Under
 * reduced motion there is no fade and the close is immediate.
 *
 * Returns the class for the dialog's root (enter or leave animation) and a
 * `close` to call instead of `onClosed`; a second call while closing is a
 * no-op, so a double Escape does not close twice.
 */
export function useFadeClose(onClosed: () => void) {
  const reduced = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const latest = useRef(onClosed);
  const timer = useRef(0);
  useEffect(() => {
    latest.current = onClosed;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const close = useCallback(() => {
    if (reduced) {
      latest.current();
      return;
    }
    setClosing((already) => {
      if (already) return already;
      timer.current = window.setTimeout(() => latest.current(), DIALOG_FADE_MS);
      return true;
    });
  }, [reduced]);

  return { closing, close, className: closing ? "dialog-leave" : "dialog-enter" };
}
