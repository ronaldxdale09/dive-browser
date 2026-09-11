import { cloneElement, useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { displayChord } from "../lib/commands";
import { useCoversContent } from "../lib/overlay";

interface TriggerProps {
  "aria-describedby"?: string;
  title?: string | undefined;
}

/** A chrome-native tooltip that also remains associated with its trigger for assistive tech. */
export function Tooltip({
  label,
  shortcut,
  align = "center",
  side = "top",
  children,
}: {
  label: string;
  shortcut?: string | undefined;
  align?: "start" | "center" | "end" | undefined;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  children: ReactNode;
}) {
  const id = useId();
  // Whether the pointer is on the trigger. The tip is revealed by CSS, which
  // nothing can observe from script, so this exists only to raise the chrome
  // over the page: a tip under a toolbar button sits on the page's rectangle
  // and is otherwise painted behind it. The tip's own delay still governs when
  // it appears; while it is `display: none` it measures 0x0 and adds no region.
  //
  // Hover only, not focus. A focused control keeps its focus for as long as the
  // person is working, and covering the page for all of it would mask the page
  // behind every toolbar button they tab through. The cost is that a tooltip
  // raised by keyboard focus alone, over a page, is still hidden -- rarer than
  // the churn the alternative buys.
  const [hovered, setHovered] = useState(false);
  useCoversContent(hovered);
  const trigger = children as ReactElement<TriggerProps>;
  const describedBy = [trigger.props["aria-describedby"], id].filter(Boolean).join(" ");
  const horizontal = align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2";
  const position =
    side === "bottom"
      ? `top-full mt-1 ${horizontal}`
      : side === "left"
        ? "top-1/2 right-full mr-1 -translate-y-1/2"
        : side === "right"
          ? "top-1/2 left-full ml-1 -translate-y-1/2"
          : `bottom-full mb-1 ${horizontal}`;

  return (
    <span
      className="group/tooltip relative inline-flex shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {cloneElement(trigger, { "aria-describedby": describedBy, title: undefined })}
      <span
        id={id}
        role="tooltip"
        // Hidden rather than invisible: a positioned element that is merely
        // invisible still counts as scrollable overflow, and a tooltip near the
        // edge of a scrolling panel gave the panel a scrollbar. It fades in
        // from its starting style after the usual delay.
        className={`pointer-events-none absolute z-50 hidden w-max max-w-56 items-center gap-2 rounded-md border border-line-2 bg-surface-2 px-2 py-1 text-[11px] leading-none whitespace-nowrap text-ink shadow-lg transition-opacity delay-500 duration-100 starting:opacity-0 group-hover/tooltip:flex group-focus-within/tooltip:flex group-focus-within/tooltip:delay-0 ${position}`}
      >
        {label}
        {shortcut && <kbd className="font-mono text-[9px] text-ink-3">{displayChord(shortcut)}</kbd>}
      </span>
    </span>
  );
}
