import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { isWindows } from "./commands";

/**
 * Width of the strip left uncovered by the page view along the window's
 * right and bottom edges on Windows, so the frameless window can be resized
 * there.
 *
 * The window has no native frame on Windows (the chrome draws its own title
 * bar), so there is no OS resize border. The page runs in its own native
 * webview that sits on top of the chrome and fills the content area out to
 * the window edge, which would swallow any pointer aimed at that edge. Holding
 * the page view a few pixels short of the right and bottom edges leaves the
 * chrome -- and the resize handles drawn over it -- reachable there. The top
 * and left edges are already chrome (the title row and the rail), so they need
 * no gutter.
 */
export const RESIZE_GUTTER = 6;

/** Corner grab squares are larger than the edge strips, as the OS draws them. */
export const RESIZE_CORNER = 14;

/** The eight directions Tauri's `startResizeDragging` accepts. */
export type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

/**
 * Begin an OS-driven resize from `direction`. Initiated from the chrome
 * webview, this reaches the parent window even though a child page view is
 * present, which a plain resize border cannot.
 */
export function beginWindowResize(direction: ResizeDirection): void {
  getCurrentWindow()
    .startResizeDragging(direction)
    .catch(() => undefined);
}

/**
 * Whether the current window is maximized. Always false off Windows, where the
 * OS frame handles resizing and none of this applies. Follows the window, so a
 * drag-to-top maximize or a double-click un-maximize is picked up too.
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isWindows()) return;
    const window = getCurrentWindow();
    let alive = true;
    const sync = () =>
      void window
        .isMaximized()
        .then((v) => alive && setMaximized(v))
        .catch(() => undefined);
    sync();
    const stop = window.onResized(sync);
    return () => {
      alive = false;
      void stop.then((off) => off()).catch(() => undefined);
    };
  }, []);
  return maximized;
}
