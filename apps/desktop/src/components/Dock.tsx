const PANELS = ["Console", "Network", "Storage", "A11y", "Vitals", "Meta"] as const;

export function Dock() {
  return (
    <section aria-label="Developer dock" className="flex min-h-0 flex-col border-t border-line bg-surface">
      <div className="flex gap-4 border-b border-line px-3 py-1.5 text-xs">
        {PANELS.map((p, i) => (
          <span key={p} className={i === 0 ? "font-medium text-ink" : "text-ink-3"}>
            {p}
          </span>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3 font-mono text-xs text-ink-3">No output yet.</div>
    </section>
  );
}
