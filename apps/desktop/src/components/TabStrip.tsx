import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AppWindow, Columns2, Moon, Pin, Plus, X } from "lucide-react";
import { useState } from "react";
import { useBrowser } from "../store/browser";
import { useLayout } from "../store/layout";
import type { Tab } from "../lib/ipc";
import { Favicon } from "./Favicon";
import { Icon, IconButton } from "./Icon";
import { useCoversContent } from "../lib/overlay";

/** What a tab is called in the strip: its title, else its host. */
export function tabLabel(t: Tab) {
  if (t.title) return t.title;
  try {
    return new URL(t.url).host || t.url;
  } catch {
    return t.url;
  }
}
const label = tabLabel;

/** Sort for display: pinned first, then by position. Sleeping (discarded)
 * tabs stay in the strip so one click wakes them. */
export function orderTabs(tabs: Tab[]): Tab[] {
  return tabs
    .filter((t) => t.tier !== "essential")
    .sort((a, b) => (a.tier === b.tier ? a.position - b.position : a.tier === "pinned" ? -1 : 1));
}

/**
 * Comet-style top strip: pill tabs, right-click to pin. Dragging is handled
 * by the `TabDnd` context around the whole chrome: within the strip a drag
 * reorders, onto the page it splits, past the window it opens a window.
 */
export function TabStrip() {
  const all = useBrowser((s) => s.tabs);
  const active = useBrowser((s) => s.activeTab);
  const detached = useBrowser((s) => s.detached);
  const workspace = useBrowser((s) => s.activeWorkspace);
  const activate = useBrowser((s) => s.activateTab);
  const close = useBrowser((s) => s.closeTab);
  const toggle = useBrowser((s) => s.toggle);
  const setPinned = useBrowser((s) => s.setPinned);
  const detachTab = useBrowser((s) => s.detachTab);
  const attachTab = useBrowser((s) => s.attachTab);
  const insertPane = useLayout((s) => s.insert);
  const tabs = orderTabs(all);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  return (
    <div className="flex h-full items-center gap-1 pr-2 pl-2" onClick={() => menu && setMenu(null)}>
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        {/* Tabs share the width the way Chrome's do: each shrinks as more
            open, down to a favicon alone, rather than the strip clipping the
            ones at the end. */}
        <div className="flex min-w-0 items-center gap-1 overflow-hidden" role="tablist">
          {tabs.map((t) => (
            <SortableTab
              key={t.id}
              tab={t}
              active={t.id === active}
              detached={detached.includes(t.id)}
              onActivate={() => void activate(t.id)}
              onClose={() => void close(t.id)}
              onMenu={(x, y) => setMenu({ id: t.id, x, y })}
            />
          ))}
        </div>
      </SortableContext>
      <IconButton icon={Plus} label="New tab" onClick={() => toggle("palette", true)} />
      <div className="min-w-3 flex-1 self-stretch" data-tauri-drag-region />
      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          pinned={all.find((t) => t.id === menu.id)?.tier === "pinned"}
          detached={detached.includes(menu.id)}
          canSplit={!!active && active !== menu.id && !detached.includes(menu.id)}
          onPin={(v) => {
            void setPinned(menu.id, v);
            setMenu(null);
          }}
          onWindow={(out) => {
            void (out ? detachTab(menu.id, null) : attachTab(menu.id));
            setMenu(null);
          }}
          onSplit={() => {
            if (workspace && active) {
              insertPane(workspace, menu.id, 1, active);
              void activate(menu.id);
            }
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

function SortableTab({ tab: t, active, detached, onActivate, onClose, onMenu }: { tab: Tab; active: boolean; detached: boolean; onActivate: () => void; onClose: () => void; onMenu: (x: number, y: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  const pinned = t.tier === "pinned";
  const sleeping = t.state === "discarded";
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
      className={`group flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs transition-colors ${pinned ? "w-9 shrink-0 justify-center px-0" : "@container min-w-9 flex-1 basis-56 max-w-56"} ${
        active ? "bg-surface-2 text-ink ring-1 ring-line-2" : "text-ink-2 hover:bg-surface hover:text-ink"
      } ${sleeping || detached ? "opacity-55 hover:opacity-100" : ""}`}
      title={detached ? `${label(t)} (in its own window)` : sleeping ? `${label(t)} (sleeping, click to wake)` : pinned ? label(t) : undefined}
      data-sleeping={sleeping || undefined}
      data-detached={detached || undefined}
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
      {sleeping && !pinned && (
        <span className="grid shrink-0 place-items-center text-ink-3" aria-label="Sleeping">
          <Icon icon={Moon} size={11} />
        </span>
      )}
      {detached && !pinned && (
        <span className="grid shrink-0 place-items-center text-ink-3" aria-label="In its own window">
          <Icon icon={AppWindow} size={11} />
        </span>
      )}
      {!pinned && (
        <button
          type="button"
          aria-label={`Close ${label(t)}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="ml-auto hidden size-5 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100 group-aria-selected:opacity-100 @[88px]:grid"
        >
          <Icon icon={X} size={12} />
        </button>
      )}
    </div>
  );
}

function TabMenu({ x, y, pinned, detached, canSplit, onPin, onWindow, onSplit, onClose, onCloseOthers }: { x: number; y: number; pinned: boolean; detached: boolean; canSplit: boolean; onPin: (v: boolean) => void; onWindow: (out: boolean) => void; onSplit: () => void; onClose: () => void; onCloseOthers: () => void }) {
  useCoversContent(true);
  const item = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink";
  return (
    <div role="menu" style={{ left: x, top: y }} className="fixed z-50 w-44 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
      <button type="button" role="menuitem" className={item} onClick={() => onPin(!pinned)}>
        <Icon icon={Pin} size={13} /> {pinned ? "Unpin tab" : "Pin tab"}
      </button>
      {canSplit && (
        <button type="button" role="menuitem" className={item} onClick={onSplit}>
          <Icon icon={Columns2} size={13} /> Split with current tab
        </button>
      )}
      <button type="button" role="menuitem" className={item} onClick={() => onWindow(!detached)}>
        <Icon icon={AppWindow} size={13} /> {detached ? "Move back to this window" : "Open in new window"}
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
