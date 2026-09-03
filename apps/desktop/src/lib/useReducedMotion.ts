import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function list(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void) {
  const query = list();
  if (!query) return () => undefined;
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the OS asks for reduced motion right now; for code outside React. */
export function prefersReducedMotion(): boolean {
  return list()?.matches ?? false;
}

/**
 * The OS "reduce motion" setting, kept current: flipping it in System
 * Settings re-renders every subscriber, so a loop that was running stops and
 * a reel that was paused starts, without a relaunch.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
