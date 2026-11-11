/**
 * Follow a pointer drag on the window. Ends on pointerup, pointercancel or
 * the window losing focus, so a button released outside the webview never
 * leaves an item following the mouse. Returns a function that ends it early
 * (for unmount).
 */
export function dragOnWindow(onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent | null) => void): () => void {
  let done = false;
  const end = (e: PointerEvent | null) => {
    if (done) return;
    done = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", blur);
    onEnd(e);
  };
  const up = (e: PointerEvent) => end(e);
  const cancel = () => end(null);
  const blur = () => end(null);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", blur);
  return () => end(null);
}
