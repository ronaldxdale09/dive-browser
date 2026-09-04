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
