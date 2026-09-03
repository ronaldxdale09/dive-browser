import { useRef } from "react";
import { dragSize, nudgeSize } from "../lib/resize";
import type { SizeLimits } from "../lib/resize";

/**
 * The draggable edge of a panel. Pointer drags report a live size on every
 * move and the final one on release, so the parent can show the panel
 * following the pointer without writing the store sixty times a second.
 * The handle is also a focusable separator: arrow keys nudge it, for anyone
 * who does not drag.
 */
export function ResizeHandle({
  orientation,
  value,
  limits,
  label,
  onResize,
  onCommit,
}: {
  /** `vertical` divides left from right (a sidecar); `horizontal` divides top from bottom (a dock). */
  orientation: "vertical" | "horizontal";
  value: number;
  limits: SizeLimits;
  label: string;
  onResize: (px: number) => void;
  onCommit: (px: number) => void;
}) {
  const vertical = orientation === "vertical";
  const ref = useRef<HTMLDivElement>(null);

  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const origin = vertical ? e.clientX : e.clientY;
    let next = value;
    const move = (ev: PointerEvent) => {
      const pos = vertical ? ev.clientX : ev.clientY;
      // Both panels sit after the page (right of it, below it), so the handle
      // is their leading edge and pulling it towards the page grows them.
      next = dragSize(value, pos - origin, -1, limits);
      onResize(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onCommit(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = vertical ? "ArrowLeft" : "ArrowUp";
    const shrink = vertical ? "ArrowRight" : "ArrowDown";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    onCommit(nudgeSize(value, e.key === grow ? 1 : -1, limits));
  };

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      onPointerDown={start}
      onKeyDown={onKey}
      className={`group relative z-10 shrink-0 touch-none ${vertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize"} bg-line outline-none`}
    >
      {/* The hit area is wider than the hairline it draws, and lights up
          while grabbed or focused so the edge is findable. */}
      <span
        aria-hidden
        className={`absolute rounded-full transition-colors group-hover:bg-line-2 group-focus-visible:bg-highlight ${vertical ? "inset-y-0 -left-1 w-[7px]" : "inset-x-0 -top-1 h-[7px]"}`}
      />
    </div>
  );
}
