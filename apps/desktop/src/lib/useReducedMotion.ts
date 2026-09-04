import { usePrefs } from "../store/prefs";
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function list(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void) {
  const query = list();
  query?.addEventListener("change", onChange);
  const off = usePrefs.subscribe((state, previous) => {
    if (state.prefs.motion !== previous.prefs.motion) onChange();
  });
  return () => { query?.removeEventListener("change", onChange); off(); };
}

/** Resolve Dive's motion choice, following the OS only in System mode. */
export function prefersReducedMotion(): boolean {
  const choice = usePrefs.getState().prefs.motion;
  if (choice === "reduce") return true;
  if (choice === "full") return false;
  return list()?.matches ?? false;
}

/**
 * The effective motion setting, kept current across Dive and OS changes,
 * re-renders every subscriber, so a loop that was running stops and
 * a reel that was paused starts, without a relaunch.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
