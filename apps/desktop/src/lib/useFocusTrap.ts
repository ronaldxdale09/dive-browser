import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** What Tab can land on. `tabindex="-1"` is reachable by script only, so it is left out. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

// Nested dialogs own their keys. An outer trap must not close the whole tray
// or move focus a second time after a child popover handles the same event.
const activeTraps = new WeakSet<HTMLElement>();

const MENU_ITEM = "[role='menuitem'],[role='menuitemradio'],[role='menuitemcheckbox']";

/** Every element inside `root` that Tab could reach, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true");
}

/** Enabled menu items inside `root`, in document order. */
export function menuItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MENU_ITEM)).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
}

/**
 * Where Tab goes next inside a trapped container: off either end it wraps to
 * the other, and from outside the list (or from nothing) it starts at an end.
 * Pure, so the cycling rule is testable without a DOM.
 */
export function nextInCycle<T>(items: T[], current: T | null, backwards: boolean): T | null {
  if (items.length === 0) return null;
  const at = current === null ? -1 : items.indexOf(current);
  if (at === -1) return backwards ? items[items.length - 1]! : items[0]!;
  return items[(at + (backwards ? items.length - 1 : 1)) % items.length]!;
}

export interface FocusTrapOptions {
  /** The trap is armed only while this is true; defaults to always. */
  active?: boolean | undefined;
  /** Focus this instead of the first focusable element on open. */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  /**
   * Treat the container as a menu: focus its first item on open and let
   * ArrowUp / ArrowDown (with Home / End) walk the items, wrapping at the ends.
   */
  menu?: boolean | undefined;
  /** Called on Escape. Dialogs that already close on Escape can leave this out. */
  onEscape?: (() => void) | undefined;
}

/**
 * Keep keyboard focus inside a dialog or menu for as long as it is open.
 *
 * On open, focus moves to `initialFocus`, else the first focusable element
 * (the first item, for a menu) -- unless something inside already has focus,
 * as with an `autoFocus` input. Tab and Shift+Tab cycle inside the container
 * instead of escaping to the chrome behind the scrim. When the trap is torn
 * down -- the component unmounts or `active` turns false -- focus goes back
 * to whatever had it before, so closing a menu returns you to its button.
 */
export function useFocusTrap<T extends HTMLElement>(ref: RefObject<T | null>, { active = true, initialFocus, menu = false, onEscape }: FocusTrapOptions = {}) {
  // Read through a ref so an inline `onEscape` does not re-arm the trap (and
  // move focus back to the first control) on every render of the caller.
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    activeTraps.add(root);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!root.contains(document.activeElement)) {
      const target = initialFocus?.current ?? (menu ? menuItems(root)[0] : undefined) ?? focusables(root)[0] ?? root;
      if (target === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      for (let node = e.target instanceof HTMLElement ? e.target : null; node && node !== root; node = node.parentElement) {
        if (activeTraps.has(node)) return;
      }
      if (e.key === "Escape" && escape.current) {
        e.stopPropagation();
        escape.current();
        return;
      }
      const current = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
      if (e.key === "Tab") {
        const items = focusables(root);
        const next = nextInCycle(items, current, e.shiftKey);
        // A container with nothing to focus keeps focus on itself rather than
        // letting Tab wander off behind the scrim.
        if (!next) {
          e.preventDefault();
          return;
        }
        // Only the wrap needs help; a Tab in the middle of the list is the
        // browser's own, and stays that way so it lands on the same element.
        const edge = e.shiftKey ? items[0] : items[items.length - 1];
        if (current === null || current === edge) {
          e.preventDefault();
          next.focus({ preventScroll: true });
        }
        return;
      }
      if (!menu) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        const items = menuItems(root);
        if (items.length === 0) return;
        e.preventDefault();
        const next = e.key === "Home" ? items[0]! : e.key === "End" ? items[items.length - 1]! : nextInCycle(items, current, e.key === "ArrowUp")!;
        next.focus({ preventScroll: true });
      }
    };
    root.addEventListener("keydown", onKey);

    return () => {
      activeTraps.delete(root);
      root.removeEventListener("keydown", onKey);
      // Give focus back only if it is still ours to give: if the user has
      // already clicked somewhere else, that click wins.
      const now = document.activeElement;
      if (previous && previous.isConnected && (now === null || now === document.body || root.contains(now))) previous.focus({ preventScroll: true });
    };
  }, [ref, active, initialFocus, menu]);
}
