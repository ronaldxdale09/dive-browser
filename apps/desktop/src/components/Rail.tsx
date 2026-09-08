import { isPrivateWindow } from "../lib/privateMode";
import { AvatarImage } from "./AvatarImage";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowRight, Globe, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings2, Shield, SquarePlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { useBrowser } from "../store/browser";
import type { Workspace } from "../lib/ipc";
import { usePrefs } from "../store/prefs";
import { useDefaultBrowser } from "../store/defaultBrowser";
import { Icon } from "./Icon";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { AiShortcuts } from "./AiShortcuts";
import { clampFloatingPosition } from "../lib/floating";

/** Rail width in each mode; App.tsx sizes the grid column from these. */
export const RAIL_WIDTH = { collapsed: 52, expanded: 208 };

/**
 * Left rail: the list of workspaces, and the only place they are created,
 * reordered or told apart.
 *
 * Expanded by default, because a column of unlabelled marks does not say what
 * it is. The names, tab counts and "own cookies" badge are the point: a
 * workspace is a set of tabs with, optionally, its own logins, and none of
 * that is guessable from a coloured circle.
 */
export function Rail({ forceCollapsed = false }: { forceCollapsed?: boolean }) {
  const all = useBrowser((s) => s.workspaces);
  const activeProfile = useBrowser((s) => s.activeProfile);
  // The rail is the active profile's: other profiles' workspaces wait
  // behind the profile switcher in the title bar.
  const workspaces = all.filter((w) => !activeProfile || w.profile_id === activeProfile);
  const active = useBrowser((s) => s.activeWorkspace);
  const activate = useBrowser((s) => s.activateWorkspace);
  const reorder = useBrowser((s) => s.reorderWorkspaces);
  const setEditing = useBrowser((s) => s.setEditing);
  const preferredExpanded = usePrefs((s) => s.prefs.rail_expanded);
  const expanded = preferredExpanded && !forceCollapsed;
  const update = usePrefs((s) => s.update);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active: dragged, over } = e;
    if (!over || dragged.id === over.id) return;
    const ids = workspaces.map((w) => w.id);
    void reorder(arrayMove(ids, ids.indexOf(String(dragged.id)), ids.indexOf(String(over.id))));
  };

  return (
    <nav aria-label="Workspaces" className={`flex h-full flex-col gap-1 px-2 pt-2 pb-2 ${expanded ? "" : "items-center"}`}>
      {expanded && !isPrivateWindow() && <AiShortcuts />}
      {expanded && (
        <div className="flex h-6 items-center gap-1 pr-0.5 pl-2">
          <span className="text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">Workspaces</span>
          <span className="flex-1" />
          <RailButton icon={PanelLeftClose} label="Collapse workspaces" onClick={() => void update({ rail_expanded: false })} />
        </div>
      )}
      {/* Scrolls rather than clips: past about a dozen workspaces the rail runs
          out of height, and a mark sliced in half is worse than one that has to
          be scrolled to. Settings stays pinned below it either way. */}
      <div className={`scroll-hidden flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto ${expanded ? "gap-1" : "items-center gap-2"}`}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={workspaces.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            {workspaces.map((w, i) => (
              <WorkspaceRow
                key={w.id}
                workspace={w}
                index={i}
                active={w.id === active}
                expanded={expanded}
                separate={workspaces.filter((other) => other.container_id === w.container_id).length === 1}
                onActivate={() => void activate(w.id)}
                onMenu={(x, y) => setMenu({ id: w.id, x, y })}
              />
            ))}
          </SortableContext>
        </DndContext>
        {!isPrivateWindow() && <button
          type="button"
          aria-label="New workspace"
          title="New workspace (⌥⇧⌘N)"
          onClick={() => setEditing({ id: null })}
          className={
            expanded
              ? "flex h-[var(--row-h)] shrink-0 items-center gap-2.5 rounded-lg px-2 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink"
              : "grid h-[var(--row-h)] w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
          }
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-[10px] border border-dashed border-line-2">
            <Icon icon={Plus} size={14} />
          </span>
          {expanded && "New workspace"}
        </button>}
      </div>
      {!expanded && !forceCollapsed && <RailButton icon={PanelLeftOpen} label="Expand workspaces" onClick={() => void update({ rail_expanded: true })} />}
      {!isPrivateWindow() && <DefaultBrowserButton expanded={expanded} />}
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={() => useBrowser.getState().toggle("settings", true)}
        className={
          expanded
            ? "flex h-[var(--row-h)] shrink-0 items-center gap-2.5 rounded-lg px-2 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink"
            : "grid h-[var(--row-h)] w-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
        }
      >
        <span className="grid size-7 shrink-0 place-items-center">
          <Icon icon={Settings2} />
        </span>
        {expanded && "Settings"}
      </button>
      {menu && <WorkspaceMenu id={menu.id} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </nav>
  );
}

/**
 * Offer to make Dive the default browser, or say that it already is. Hidden
 * on builds that cannot ask. The status is read once and again whenever the
 * window regains focus, so a change made in System Settings shows up.
 */
function DefaultBrowserButton({ expanded }: { expanded: boolean }) {
  const status = useDefaultBrowser((s) => s.status);
  const declined = useDefaultBrowser((s) => s.declined);
  const refresh = useDefaultBrowser((s) => s.refresh);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  // Once Dive is the default there is nothing to offer, so the row goes; a
  // "Not now" rests it for a couple of weeks rather than nagging every
  // launch. Settings › General keeps offering meanwhile.
  if (!status?.supported || status.is_default || declined) return null;
  const title = "Make Dive the default browser";
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={() => useBrowser.getState().toggle("defaultBrowser", true)}
      className={
        expanded
          ? "group flex h-11 shrink-0 items-center gap-2.5 rounded-xl border border-accent/25 bg-accent/8 px-2 text-left text-xs text-ink transition-colors hover:border-accent/45 hover:bg-accent/14"
          : "group grid h-[var(--row-h)] w-9 shrink-0 place-items-center rounded-full text-accent transition-colors hover:bg-accent/14"
      }
    >
      <span className={expanded ? "grid size-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent" : "relative grid size-7 place-items-center"}>
        <Icon icon={Globe} size={14} />
        {!expanded && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" aria-hidden />}
      </span>
      {expanded && (
        <>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[12px] font-medium">Set as default</span>
            <span className="truncate text-[10.5px] text-ink-3">Open links in Dive</span>
          </span>
          <span className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 transition-colors group-hover:bg-accent group-hover:text-accent-ink" aria-hidden>
            <Icon icon={ArrowRight} size={11} />
          </span>
        </>
      )}
    </button>
  );
}

function RailButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
    >
      <Icon icon={icon} size={14} />
    </button>
  );
}

function WorkspaceRow({
  workspace: w,
  index,
  active,
  expanded,
  separate,
  onActivate,
  onMenu,
}: {
  workspace: Workspace;
  index: number;
  active: boolean;
  expanded: boolean;
  separate: boolean;
  onActivate: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const count = useBrowser((s) => s.counts[w.id] ?? 0);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  // Only the first nine are reachable by chord, so only those advertise one.
  const shortcut = index < 9 ? ` (⌘${index + 1})` : "";
  const summary = `${w.name} — ${count} ${count === 1 ? "tab" : "tabs"}${separate ? ", own cookies" : ""}${shortcut}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      title={summary}
      aria-label={summary}
      onClick={onActivate}
      onKeyDown={(e) => e.key === "Enter" && onActivate()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={
        expanded
          ? `relative flex h-[var(--row-h)] shrink-0 items-center gap-2.5 rounded-lg px-2 transition-colors ${active ? "bg-surface-3 text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`
          : `relative grid h-[var(--row-h)] w-9 shrink-0 place-items-center rounded-full transition-[background-color,box-shadow,transform] ${active ? "bg-surface-3 ring-1 ring-line-2" : "hover:bg-surface-2"}`
      }
    >
      {/* A generated mark rather than a shared glyph: every workspace gets a
          shape of its own, on the color it was given, so the rail is scanned by
          appearance instead of by reading labels. Inactive ones sit back. */}
      <AvatarImage kind="workspace" seed={w.icon} color={w.color}
        alt=""
        width={28}
        height={28}
        className={`size-7 shrink-0 rounded-[10px] transition-opacity ${active ? "" : "opacity-60"}`}
      />
      {expanded && <span className="min-w-0 flex-1 truncate text-xs">{w.name}</span>}
      {expanded && separate && <Icon icon={Shield} size={11} className="shrink-0 text-ink-3" />}
      {expanded && count > 0 && <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">{count}</span>}
      {/* Inset from the window edge: the row is centred in the rail, so
          `-left-2` put this at x=0, where it read as a sliced-off sliver
          rather than a marker. */}
      {active && <span className={`absolute h-5 w-[3px] rounded-full bg-highlight ${expanded ? "-left-1" : "-left-1.5"}`} aria-hidden />}
      {/* Collapsed, the count has nowhere to sit but the mark itself. */}
      {!expanded && count > 0 && (
        <span className="absolute -right-0.5 -bottom-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-surface-3 px-1 font-mono text-[9px] text-ink-2 tabular-nums">
          {count}
        </span>
      )}
    </div>
  );
}

/**
 * Right-click menu for one workspace. Deleting confirms in place: it closes
 * every tab in the workspace, which is not something to do on one click.
 */
function WorkspaceMenu({ id, x, y, onClose }: { id: string; x: number; y: number; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useFocusTrap(root, { menu: true });
  const workspaces = useBrowser((s) => s.workspaces);
  const count = useBrowser((s) => s.counts[id] ?? 0);
  const activate = useBrowser((s) => s.activateWorkspace);
  const remove = useBrowser((s) => s.deleteWorkspace);
  const setEditing = useBrowser((s) => s.setEditing);
  const toggle = useBrowser((s) => s.toggle);
  const [confirming, setConfirming] = useState(false);
  const workspace = workspaces.find((w) => w.id === id);
  // Only a menu that renders covers the page; a stale id renders nothing.
  useCoversContent(Boolean(workspace));
  const position = clampFloatingPosition({ x, y, width: 224, height: confirming ? 150 : 176, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
  const item = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink";
  if (!workspace) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        ref={root}
        role="menu"
        aria-label={workspace.name}
        style={{ left: position.x, top: position.y }}
        className="surface-enter fixed z-50 w-56 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="flex items-center gap-2 px-2 pt-1 pb-2">
          <AvatarImage kind="workspace" seed={workspace.icon} color={workspace.color} alt="" width={20} height={20} className="size-5 rounded-md" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{workspace.name}</span>
          <span className="font-mono text-[10px] text-ink-3">{count}</span>
        </div>
        {confirming ? (
          <div className="px-2 pb-1">
            <p className="text-[11px] leading-relaxed text-ink-2">
              {count === 0 ? `Delete ${workspace.name}? It has no open tabs.` : `Delete ${workspace.name} and close its ${count} ${count === 1 ? "tab" : "tabs"}?`}
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={onClose} className="h-7 flex-1 rounded-full border border-line text-[11px] text-ink-2 hover:bg-surface-2">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void remove(id);
                  onClose();
                }}
                className="h-7 flex-1 rounded-full bg-danger text-[11px] font-medium text-danger-ink"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                void activate(id).then(() => toggle("palette", true));
                onClose();
              }}
            >
              <Icon icon={SquarePlus} size={13} /> New tab here
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setEditing({ id });
                onClose();
              }}
            >
              <Icon icon={Pencil} size={13} /> Edit workspace…
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={workspaces.length <= 1}
              className={`${item} text-danger hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent`}
              onClick={() => setConfirming(true)}
            >
              <Icon icon={Trash2} size={13} /> Delete workspace
            </button>
          </>
        )}
      </div>
    </>
  );
}
