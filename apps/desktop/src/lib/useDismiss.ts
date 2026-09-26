import { useLayoutEffect, type RefObject } from "react";

/**
 * Close an anchored popover the way people expect: a click outside it, the
 * Escape key, or focus moving somewhere else in the chrome (⌘F, ⌘L, the
 * palette). Without the last rule a popover stayed up over the find bar and
 * hid it. `root` is the element that holds both the button and the panel.
 *
 * The window losing focus closes it too. The page is a native view above the
 * chrome, and a click into it never reaches the chrome as a mousedown -- the
 * chrome only sees its window blur. Without this a menu stayed open while
 * the person scrolled and clicked around the page under it.
 */
export function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  // Wired as the popover is committed, not after paint: a press or Escape
  // that lands in between (a quick double action, a busy frame) otherwise
  // finds nothing listening and the popover stays up.
  useLayoutEffect(() => {
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
    const onBlur = () => close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onBlur);
    };
  }, [root, open, close]);
}
