export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Read only the geometry the native host accepts, rather than retaining a live DOMRect. */
export function elementBounds(element: Element): Bounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function sameBounds(a: Bounds | null, b: Bounds): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Collapse ResizeObserver and window-resize bursts into one layout read per
 * animation frame. An unchanged rectangle never crosses the IPC boundary.
 */
export function createBoundsReporter(read: () => Bounds, report: (bounds: Bounds) => void) {
  let frame: number | null = null;
  let last: Bounds | null = null;
  let disposed = false;

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (disposed) return;
      const next = read();
      if (sameBounds(last, next)) return;
      last = next;
      report(next);
    });
  };

  const dispose = () => {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };

  return { schedule, dispose };
}
