import { Accessibility, Activity, Database, FileSearch, Network, Terminal } from "lucide-react";
import { Icon } from "./Icon";

const PANELS = [
  { label: "Console", icon: Terminal },
  { label: "Network", icon: Network },
  { label: "Storage", icon: Database },
  { label: "A11y", icon: Accessibility },
  { label: "Vitals", icon: Activity },
  { label: "Meta", icon: FileSearch },
] as const;

/** Bottom developer dock. Panels fill in during Phase 2. */
export function Dock() {
  return (
    <section aria-label="Developer dock" className="flex min-h-0 flex-col bg-surface">
      <div className="flex gap-1 px-2 pt-2 pb-1">
        {PANELS.map((p, i) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={i === 0}
            className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-3 aria-pressed:text-ink"
          >
            <Icon icon={p.icon} size={13} />
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto px-3 py-2 font-mono text-xs text-ink-3">No console output yet.</div>
    </section>
  );
}
