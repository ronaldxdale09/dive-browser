import { useLayoutEffect } from "react";
import type { RefObject } from "react";

const DEFAULT_MARGIN = 12;

/** Clamp a fixed-position surface into the visible viewport. */
export function clampFloatingPosition({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = DEFAULT_MARGIN,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}) {
  return {
    x: Math.max(margin, Math.min(x, Math.max(margin, viewportWidth - width - margin))),
    y: Math.max(margin, Math.min(y, Math.max(margin, viewportHeight - height - margin))),
  };
}

/**
 * Keep a fixed menu opened at (x, y) inside the window by its real size.
 *
 * A menu clamped with a guessed height (rows times a row height) came out
 * short whenever a row wrapped, a separator was added or the density changed,
 * so one opened near the bottom of the window lost its last rows. This
 * measures the rendered menu before it is painted and moves it, on every
 * render, since what the menu holds can change while it is open. The style
 * written by the caller is the first guess; this corrects the element
 * directly rather than through state, so there is no second render.
 */
export function useClampToViewport(ref: RefObject<HTMLElement | null>, x: number, y: number, margin = DEFAULT_MARGIN) {
  useLayoutEffect(() => {
    const el = ref.current;
    // offsetWidth/Height ignore the entry animation's scale.
    if (!el || !el.offsetWidth || !el.offsetHeight) return;
    const at = clampFloatingPosition({ x, y, width: el.offsetWidth, height: el.offsetHeight, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, margin });
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
  });
}
