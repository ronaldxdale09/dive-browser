import { cloneElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";

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
    <span className="group/tooltip relative inline-flex shrink-0">
      {cloneElement(trigger, { "aria-describedby": describedBy, title: undefined })}
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none invisible absolute z-50 flex w-max max-w-56 items-center gap-2 rounded-md border border-line-2 bg-surface-2 px-2 py-1 text-[11px] leading-none whitespace-nowrap text-ink opacity-0 shadow-lg transition-opacity delay-500 duration-100 group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100 group-focus-within/tooltip:delay-0 ${position}`}
      >
        {label}
        {shortcut && <kbd className="font-mono text-[9px] text-ink-3">{shortcut}</kbd>}
      </span>
    </span>
  );
}
