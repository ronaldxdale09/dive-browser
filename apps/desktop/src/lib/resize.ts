/**
 * The arithmetic behind a drag handle on a panel edge, kept apart from the
 * pointer plumbing so it can be tested as numbers.
 */

export interface SizeLimits {
  min: number;
  max: number;
}

export const DOCK_LIMITS: SizeLimits = { min: 160, max: 600 };
export const SIDECAR_LIMITS: SizeLimits = { min: 280, max: 720 };

export function clampSize(value: number, { min, max }: SizeLimits): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * Size after the pointer has moved `delta` px from where the drag began.
 * `grow` maps pointer movement to panel size: `-1` for a panel whose handle
 * sits on its leading edge (a dock at the bottom, a sidecar on the right),
 * since dragging that edge up or left -- a negative delta -- makes it bigger.
 */
export function dragSize(start: number, delta: number, grow: 1 | -1, limits: SizeLimits): number {
  return clampSize(start + delta * grow, limits);
}

/** Size after a keyboard nudge on the handle, one `step` in the growing direction. */
export function nudgeSize(current: number, direction: 1 | -1, limits: SizeLimits, step = 16): number {
  return clampSize(current + direction * step, limits);
}
