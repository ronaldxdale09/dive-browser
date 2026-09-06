import type { LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

/**
 * What a list shows when it has nothing to list: a glyph in a muted tile, one
 * line saying so, and at most one line on how to change that. Shared by the
 * library, the downloads menu and any other list so the empties read alike.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
  /** Tighter spacing for a popover, where the dialog sizing would dominate. */
  compact?: boolean;
}) {
  return (
    <div role="status" className={`flex flex-col items-center text-center ${compact ? "gap-1.5 px-3 py-5" : "gap-2 px-6 py-12"}`}>
      <span className={`grid place-items-center rounded-xl bg-surface-2 text-ink-3 ${compact ? "size-8" : "size-10"}`}>
        <Icon icon={icon} size={compact ? 15 : 18} />
      </span>
      <p className={`font-medium text-ink ${compact ? "text-[11px]" : "text-xs"}`}>{title}</p>
      {hint && <p className={`max-w-[320px] text-ink-3 ${compact ? "text-[10.5px]" : "text-[11px]"}`}>{hint}</p>}
      {action && (
        <button type="button" onClick={action.onClick} className="mt-1 h-7 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
          {action.label}
        </button>
      )}
    </div>
  );
}
