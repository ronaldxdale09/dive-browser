import { useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { displayChord } from "../lib/commands";
import { useCoversContent } from "../lib/overlay";

/**
 * A tooltip for the rail. The rail's lists scroll, and a scrolling box clips
 * anything positioned outside it, so the chrome's CSS tooltip never shows
 * beside a mark; this one renders into the document body at the trigger's
 * position while the pointer or focus is on it. The trigger's aria-label
 * already says what the tip says, so assistive tech loses nothing.
 */
export function RailTooltip({ label, shortcut, children }: { label: string; shortcut?: string | undefined; children: ReactNode }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // It is portalled to the body at the trigger's right edge, which is over the
  // content column -- where a native page paints above the chrome.
  useCoversContent(at !== null);
  // The wrapper is `display: contents` and so has no box of its own; the
  // trigger is its first real child.
  const show = (wrapper: HTMLElement) => {
    const rect = (wrapper.firstElementChild ?? wrapper).getBoundingClientRect();
    setAt({ left: rect.right + 8, top: rect.top + rect.height / 2 });
  };
  return (
    <span className="contents" onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => setAt(null)} onFocusCapture={(e) => show(e.currentTarget)} onBlurCapture={() => setAt(null)}>
      {children}
      {at &&
        createPortal(
          <span role="tooltip" style={{ left: at.left, top: at.top }} className="pointer-events-none fixed z-[60] flex -translate-y-1/2 items-center gap-2 rounded-md border border-line-2 bg-surface-2 px-2 py-1 text-[11px] leading-none whitespace-nowrap text-ink shadow-lg">
            {label}
            {shortcut && <kbd className="font-mono text-[9px] text-ink-3">{displayChord(shortcut)}</kbd>}
          </span>,
          document.body,
        )}
    </span>
  );
}
