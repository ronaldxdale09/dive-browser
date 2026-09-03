export function Sidecar() {
  return (
    <aside aria-label="Agent" className="flex min-h-0 flex-col border-l border-line bg-surface">
      <div className="flex gap-3 border-b border-line px-3 py-2 text-xs">
        <span className="font-medium text-accent-ink">Chat</span>
        <span className="text-ink-3">Trace</span>
        <span className="text-ink-3">Watchers</span>
        <span className="text-ink-3">Skills</span>
      </div>
      <div className="flex-1 overflow-auto p-3 text-xs text-ink-2">Agent runtime not connected yet.</div>
      <div className="border-t border-line p-2">
        <input disabled placeholder="Ask about this tab…" className="h-8 w-full rounded-md border border-line bg-ground px-2 text-xs" />
      </div>
    </aside>
  );
}
