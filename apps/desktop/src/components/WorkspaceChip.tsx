import { ChevronDown, Plus, Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBrowser } from "../store/browser";
import { workspaceAvatar } from "../lib/workspaceAvatar";
import { Icon } from "./Icon";
import { useCoversContent } from "../lib/overlay";

/**
 * The workspace you are in, in the title bar, next to the tabs it owns.
 *
 * The rail can be collapsed and the tab strip says nothing about which set of
 * tabs it is showing, so without this there is no answer on screen to "where
 * am I?". Clicking it switches, which is also the fastest path for someone who
 * has not learned ⌘1–⌘9 yet.
 */
export function WorkspaceChip() {
  const workspaces = useBrowser((s) => s.workspaces);
  const active = useBrowser((s) => s.activeWorkspace);
  const activate = useBrowser((s) => s.activateWorkspace);
  const setEditing = useBrowser((s) => s.setEditing);
  const counts = useBrowser((s) => s.counts);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useCoversContent(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = workspaces.find((w) => w.id === active);
  if (!current) return null;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Workspace: ${current.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 max-w-44 items-center gap-1.5 rounded-full border border-line pr-1.5 pl-1 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <img src={workspaceAvatar(current.icon, current.color)} alt="" width={20} height={20} className="size-5 shrink-0 rounded-md" />
        <span className="truncate font-medium">{current.name}</span>
        <Icon icon={ChevronDown} size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <div role="menu" aria-label="Switch workspace" className="absolute left-0 z-50 mt-1 w-64 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl">
          <div className="px-2 pt-1 pb-1.5 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">Workspaces</div>
          {workspaces.map((w, i) => {
            const separate = workspaces.filter((other) => other.container_id === w.container_id).length === 1;
            const count = counts[w.id] ?? 0;
            return (
              <button
                key={w.id}
                type="button"
                role="menuitemradio"
                aria-checked={w.id === active}
                onClick={() => {
                  setOpen(false);
                  if (w.id !== active) void activate(w.id);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink aria-checked:bg-surface-3 aria-checked:text-ink"
              >
                <img src={workspaceAvatar(w.icon, w.color)} alt="" width={20} height={20} className="size-5 shrink-0 rounded-md" />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {separate && <Icon icon={Shield} size={11} className="shrink-0 text-ink-3" />}
                <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">{count}</span>
                {i < 9 && <kbd className="shrink-0 rounded bg-surface-3 px-1 font-mono text-[10px] text-ink-3">⌘{i + 1}</kbd>}
              </button>
            );
          })}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setEditing({ id: null });
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <span className="grid size-5 shrink-0 place-items-center rounded-md border border-dashed border-line-2">
              <Icon icon={Plus} size={12} />
            </span>
            New workspace…
            <kbd className="ml-auto rounded bg-surface-3 px-1 font-mono text-[10px] text-ink-3">⌘⇧N</kbd>
          </button>
          <p className="px-2 pt-1.5 pb-1 text-[11px] leading-relaxed text-ink-3">
            A workspace keeps its own tabs; one with <Icon icon={Shield} size={10} className="inline align-[-1px]" /> also keeps its own cookies and logins.
          </p>
        </div>
      )}
    </div>
  );
}
