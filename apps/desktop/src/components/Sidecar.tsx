import { MessageSquare, ListTree, Radar, Wand2, ArrowUp } from "lucide-react";
import { Icon } from "./Icon";

const TABS = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "trace", label: "Trace", icon: ListTree },
  { id: "watchers", label: "Watchers", icon: Radar },
  { id: "skills", label: "Skills", icon: Wand2 },
] as const;

/** Right-docked agent panel (Comet's Sidecar). Runtime lands in Phase 3. */
export function Sidecar() {
  return (
    <aside aria-label="Agent" className="flex min-h-0 flex-col bg-surface">
      <div className="flex gap-1 px-2 pt-2 pb-1">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={i === 0}
            className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-3 aria-pressed:text-ink"
          >
            <Icon icon={t.icon} size={13} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-ink-3">
        <span className="grid size-10 place-items-center rounded-full bg-surface-3 text-ink-2">
          <Icon icon={MessageSquare} size={18} />
        </span>
        <p>Ask about this tab, its console, or the last request.</p>
      </div>
      <div className="p-2">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface-2 p-2">
          <textarea
            disabled
            rows={2}
            placeholder="Agent runtime arrives in Phase 3"
            className="min-h-9 flex-1 resize-none bg-transparent text-xs outline-none placeholder:text-ink-3"
          />
          <button type="button" disabled aria-label="Send" className="grid size-7 place-items-center rounded-full bg-accent text-accent-ink opacity-40">
            <Icon icon={ArrowUp} size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
