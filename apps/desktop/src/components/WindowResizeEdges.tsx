import { isWindows } from "../lib/commands";
import {
  RESIZE_CORNER,
  RESIZE_GUTTER,
  beginWindowResize,
  useWindowMaximized,
  type ResizeDirection,
} from "../lib/windowResize";

/**
 * Resize handles for the frameless Windows window.
 *
 * With no OS frame there is no resize border, and the page runs in a native
 * view that covers the content out to the window edge, so a plain border would
 * be unreachable anyway. These strips sit over the chrome -- which the page
 * view is held a few pixels short of on the right and bottom (see
 * `RESIZE_GUTTER`) -- and hand a press straight to the OS resize loop.
 *
 * They stay clear of the title row: that band is the window's drag region and
 * holds the min/maximise/close controls, so a resize strip there would break
 * moving the window and clicking those buttons. Height still grows from the
 * bottom, width from either side. Nothing renders off Windows or while
 * maximized, where the OS handles resizing.
 */
export function WindowResizeEdges({ top = 44 }: { top?: number } = {}) {
  const maximized = useWindowMaximized();
  if (!isWindows() || maximized) return null;

  const handle = (
    key: string,
    direction: ResizeDirection,
    style: React.CSSProperties,
    cursor: string,
  ) => (
    <div
      key={key}
      aria-hidden
      data-tauri-drag-region="false"
      onMouseDown={(e) => {
        // Left button only, and never let it start a text selection or a
        // window drag from the region underneath.
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        beginWindowResize(direction);
      }}
      style={{ position: "fixed", zIndex: 60, cursor, ...style }}
    />
  );

  return (
    <>
      {handle("w", "West", { top, left: 0, bottom: 0, width: RESIZE_GUTTER }, "ew-resize")}
      {handle("e", "East", { top, right: 0, bottom: 0, width: RESIZE_GUTTER }, "ew-resize")}
      {handle("s", "South", { left: 0, right: 0, bottom: 0, height: RESIZE_GUTTER }, "ns-resize")}
      {/* Corners sit above the edges so a diagonal drag wins there. */}
      {handle(
        "sw",
        "SouthWest",
        { left: 0, bottom: 0, width: RESIZE_CORNER, height: RESIZE_CORNER, zIndex: 61 },
        "nesw-resize",
      )}
      {handle(
        "se",
        "SouthEast",
        { right: 0, bottom: 0, width: RESIZE_CORNER, height: RESIZE_CORNER, zIndex: 61 },
        "nwse-resize",
      )}
    </>
  );
}
