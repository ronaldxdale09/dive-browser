import { useEffect } from "react";
import { ipc } from "./ipc";

/**
 * The page is a native child webview and those always paint above the chrome
 * webview, so any DOM overlay drawn over the content area would be buried
 * behind it. Overlays declare themselves here and the engine hides the page
 * while at least one of them is on screen.
 *
 * `active` is required rather than defaulting to `true`. A component that
 * renders `null` when it is closed still runs its hooks, so a bare
 * `useCoversContent()` in one of those holds the page hidden for the life of
 * the app -- the whole content area goes black with nothing on screen to
 * explain it. Making the caller state when it covers turns that mistake into
 * a type error.
 */
let depth = 0;
let covered = false;

function sync() {
  const next = depth > 0;
  if (next === covered) return;
  covered = next;
  void ipc.setContentCovered(next).catch(() => undefined);
}

/** Hide the page for as long as this component is mounted with `active`. */
export function useCoversContent(active: boolean) {
  useEffect(() => {
    if (!active) return;
    depth += 1;
    sync();
    return () => {
      depth -= 1;
      sync();
    };
  }, [active]);
}

/**
 * How many overlays are holding the page hidden.
 *
 * The invariant is that this is zero whenever nothing is on screen over the
 * content area; a non-zero count with no visible overlay is the bug described
 * above, so tests assert on it.
 */
export function contentCoverDepth() {
  return depth;
}

/** Reset the shared counter; tests only. */
export function resetContentCover() {
  depth = 0;
  covered = false;
}
