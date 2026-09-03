import { useEffect } from "react";
import { ipc } from "./ipc";

/**
 * The page is a native child webview and those always paint above the chrome
 * webview, so any DOM overlay drawn over the content area would be buried
 * behind it. Overlays declare themselves here and the engine hides the page
 * while at least one of them is on screen.
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
export function useCoversContent(active = true) {
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

/** Reset the shared counter; tests only. */
export function resetContentCover() {
  depth = 0;
  covered = false;
}
