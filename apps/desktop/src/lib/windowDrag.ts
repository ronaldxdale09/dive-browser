import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Dragging the window by its chrome.
 *
 * Tauri moves the window when a press lands on an element that itself carries
 * `data-tauri-drag-region`; it looks at the event's target and no further. In
 * a bar made of nested flex rows that leaves almost nothing to grab -- the
 * header is a drag region, but every pixel of it is covered by a child that
 * is not, so the window only moves from the few slivers of filler between
 * controls. People reasonably conclude the window cannot be dragged.
 *
 * So the rule is inverted here: a press anywhere in the bar drags the window
 * unless it landed on something that does its own thing with a press. That is
 * how a native title bar behaves, and it means new chrome is draggable by
 * default rather than only once somebody remembers to mark it.
 */

/**
 * Things a press belongs to rather than to the window.
 *
 * Controls and text, plus `[data-tauri-drag-region="false"]`, which the tab
 * strip and the window buttons already use to say "this press is mine".
 */
const KEEPS_ITS_PRESS = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[contenteditable]",
  "[role='button']",
  "[role='tab']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='menuitem']",
  "[data-no-drag]",
  '[data-tauri-drag-region="false"]',
].join(",");

/** Whether a press on `target` should move the window. */
export function pressMovesWindow(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(KEEPS_ITS_PRESS)) return false;
  // Tauri's own handler already moves the window for these; letting both run
  // would start the drag twice.
  return target.getAttribute("data-tauri-drag-region") !== "true";
}

/** Whether this press is the one that starts a drag: primary, unmodified. */
function isPlainPrimary(e: {
  button: number;
  detail: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/**
 * Handlers that make a bar behave like a title bar: drag to move, double-click
 * to zoom. Spread onto any chrome row.
 *
 * ```tsx
 * <header {...windowDrag()}>…</header>
 * ```
 */
export function windowDrag(): {
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
} {
  return {
    onMouseDown: (e) => {
      // The second press of a double-click is the zoom gesture, not a drag.
      if (!isPlainPrimary(e) || e.detail > 1 || !pressMovesWindow(e.target)) return;
      void getCurrentWindow().startDragging().catch(() => undefined);
    },
    onDoubleClick: (e) => {
      if (!isPlainPrimary(e) || !pressMovesWindow(e.target)) return;
      void getCurrentWindow().toggleMaximize().catch(() => undefined);
    },
  };
}
