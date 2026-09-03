import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, Pin, Plus, X } from "lucide-react";
import { useState } from "react";
import { useBrowser } from "../store/browser";
import type { Tab } from "../lib/ipc";
import { Favicon } from "./Favicon";
import { Icon, IconButton } from "./Icon";
import { useCoversContent } from "../lib/overlay";

function label(t: Tab) {
  if (t.title) return t.title;
  try {
    return new URL(t.url).host || t.url;
  } catch {
    return t.url;
  }
}

/** Sort for display: pinned first, then by position. */
export function orderTabs(tabs: Tab[]): Tab[] {
  return tabs
    .filter((t) => t.tier !== "essential" && t.state !== "discarded")
    .sort((a, b) => (a.tier === b.tier ? a.position - b.position : a.tier === "pinned" ? -1 : 1));
}

/** Comet-style top strip: pill tabs, drag to reorder, right-click to pin. */
export function TabStrip() {
  const all = useBrowser((s) => s.tabs);
  const active = useBrowser((s) => s.activeTab);
  const activate = useBrowser((s) => s.activateTab);
  const close = useBrowser((s) => s.closeTab);
  const toggle = useBrowser((s) => s.toggle);
  const reorder = useBrowser((s) => s.reorderTabs);
  const setPinned = useBrowser((s) => s.setPinned);
  const tabs = orderTabs(all);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const onDragEnd = (e: DragEndEvent) => {
    const { active: a, over } = e;
    if (!over || a.id === over.id) return;
    const ids = tabs.map((t) => t.id);
    const next = arrayMove(ids, ids.indexOf(String(a.id)), ids.indexOf(String(over.id)));
    void reorder(next);
  };

  return (
    <div className="flex h-full items-center gap-1 pr-2 pl-2" onClick={() => menu && setMenu(null)}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex min-w-0 items-center gap-1 overflow-hidden" role="tablist">
            {tabs.map((t) => (
              <SortableTab
                key={t.id}
                tab={t}
                active={t.id === active}
                onActivate={() => void activate(t.id)}
                onClose={() => void close(t.id)}
                onMenu={(x, y) => setMenu({ id: t.id, x, y })}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <IconButton icon={Plus} label="New tab" onClick={() => toggle("palette", true)} />
      <div className="min-w-3 flex-1 self-stretch" data-tauri-drag-region />
      {import.meta.env.DEV && (
        <span
          aria-label="Development environment"
          title="Development environment"
          className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-danger/40 bg-danger/15 px-2 font-mono text-[10px] font-semibold tracking-[0.12em] text-danger"
        >
          <span className="size-1.5 rounded-full bg-danger" aria-hidden />
          DEV
        </span>
      )}
      <IconButton icon={ChevronDown} label="All tabs" onClick={() => toggle("palette", true)} size={14} />
      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          pinned={all.find((t) => t.id === menu.id)?.tier === "pinned"}
          onPin={(v) => {
            void setPinned(menu.id, v);
            setMenu(null);
          }}
          onClose={() => {
            void close(menu.id);
            setMenu(null);
          }}
          onCloseOthers={() => {
            for (const t of tabs) if (t.id !== menu.id && t.tier !== "pinned") void close(t.id);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

function SortableTab({ tab: t, active, onActivate, onClose, onMenu }: { tab: Tab; active: boolean; onActivate: () => void; onClose: () => void; onMenu: (x: number, y: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  const pinned = t.tier === "pinned";
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => e.key === "Enter" && onActivate()}
      onAuxClick={(e) => e.button === 1 && onClose()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={`group flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs transition-colors ${pinned ? "w-9 justify-center px-0" : "max-w-56 min-w-28"} ${
        active ? "bg-surface-2 text-ink ring-1 ring-line-2" : "text-ink-2 hover:bg-surface hover:text-ink"
      }`}
      title={pinned ? label(t) : undefined}
    >
      {/* A pinned tab is icon-only, so the site's own mark is the only thing
          left to tell it apart; the pin itself moves to a corner dot. */}
      <span className="relative grid shrink-0 place-items-center">
        <Favicon src={t.favicon} size={pinned ? 16 : 14} />
        {pinned && (
          <span className="absolute -right-1.5 -bottom-1 grid size-3 place-items-center rounded-full bg-surface-2 text-ink-3" aria-hidden>
            <Icon icon={Pin} size={8} />
          </span>
        )}
      </span>
      {!pinned && <span className="truncate">{label(t)}</span>}
      {!pinned && (
        <button
          type="button"
          aria-label={`Close ${label(t)}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="ml-auto grid size-5 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100"
        >
          <Icon icon={X} size={12} />
        </button>
      )}
    </div>
  );
}

function TabMenu({ x, y, pinned, onPin, onClose, onCloseOthers }: { x: number; y: number; pinned: boolean; onPin: (v: boolean) => void; onClose: () => void; onCloseOthers: () => void }) {
  useCoversContent();
  const item = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink";
  return (
    <div role="menu" style={{ left: x, top: y }} className="fixed z-50 w-44 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
      <button type="button" role="menuitem" className={item} onClick={() => onPin(!pinned)}>
        <Icon icon={Pin} size={13} /> {pinned ? "Unpin tab" : "Pin tab"}
      </button>
      <button type="button" role="menuitem" className={item} onClick={onClose}>
        <Icon icon={X} size={13} /> Close tab
      </button>
      <button type="button" role="menuitem" className={item} onClick={onCloseOthers}>
        <Icon icon={X} size={13} /> Close other tabs
      </button>
    </div>
  );
}
