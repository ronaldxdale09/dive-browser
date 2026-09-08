import { useEffect, type RefObject } from "react";

/**
 * Close an anchored popover the way people expect: a click outside it, the
 * Escape key, or focus moving somewhere else in the chrome (⌘F, ⌘L, the
 * palette). Without the last rule a popover stayed up over the find bar and
 * hid it. `root` is the element that holds both the button and the panel.
 */
export function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) => !root.current?.contains(target as Node);
    const onDown = (e: MouseEvent) => {
      if (outside(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (outside(e.target)) close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focusin", onFocusIn);
    };
  }, [root, open, close]);
}
