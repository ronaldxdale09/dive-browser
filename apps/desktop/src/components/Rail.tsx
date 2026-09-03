import { useBrowser } from "../store/browser";

export function Rail() {
  const workspaces = useBrowser((s) => s.workspaces);
  const active = useBrowser((s) => s.activeWorkspace);
  const activate = useBrowser((s) => s.activateWorkspace);
  return (
    <nav aria-label="Workspaces" className="flex h-full flex-col items-center gap-2 pt-10">
      {workspaces.map((w) => (
        <button
          key={w.id}
          type="button"
          title={w.name}
          aria-pressed={w.id === active}
          onClick={() => void activate(w.id)}
          className="grid size-8 place-items-center rounded-lg border text-[11px] font-semibold uppercase transition-colors aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-ink border-transparent text-ink-2 hover:bg-surface"
        >
          <span className="size-2.5 rounded-full" style={{ background: w.color }} aria-hidden />
        </button>
      ))}
    </nav>
  );
}
