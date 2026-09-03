import { Plus, Settings2 } from "lucide-react";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";

/** Left rail: one round button per workspace, like app avatars. */
export function Rail() {
  const workspaces = useBrowser((s) => s.workspaces);
  const active = useBrowser((s) => s.activeWorkspace);
  const activate = useBrowser((s) => s.activateWorkspace);
  const setEditing = useBrowser((s) => s.setEditing);
  return (
    <nav aria-label="Workspaces" className="flex h-full flex-col items-center gap-2 pt-2 pb-3">
      {workspaces.map((w) => {
        const isActive = w.id === active;
        return (
          <button
            key={w.id}
            type="button"
            title={w.name}
            aria-pressed={isActive}
            onClick={() => void activate(w.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setEditing({ id: w.id });
            }}
            className={`relative grid size-9 place-items-center rounded-full text-[12px] font-semibold uppercase transition-all ${
              isActive ? "bg-surface-3 text-ink ring-1 ring-line-2" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <span className="grid size-6 place-items-center rounded-full text-[11px]" style={{ background: w.color, color: "#0b0b0b" }}>
              {w.name.slice(0, 1)}
            </span>
            {isActive && <span className="absolute -left-2 h-5 w-0.5 rounded-full bg-highlight" aria-hidden />}
          </button>
        );
      })}
      <button type="button" aria-label="New workspace" title="New workspace" onClick={() => setEditing({ id: null })} className="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink">
        <Icon icon={Plus} />
      </button>
      <div className="mt-auto">
        <button type="button" aria-label="Settings" title="Settings" className="grid size-9 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink">
          <Icon icon={Settings2} />
        </button>
      </div>
    </nav>
  );
}
