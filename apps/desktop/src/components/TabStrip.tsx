import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AppWindow, Columns2, Loader2, Moon, Pin, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const loading = useBrowser((s) => s.loading);
  const tabs = orderTabs(all);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [tablistRef, narrow] = useNarrowTabs(tabs.length);
  // Roving tabindex: one tab is in the Tab order at a time, the focused one
  // if any, else the active one. The arrow keys move focus without activating.
  const [focused, setFocused] = useState<string | null>(null);
  const stop = tabs.some((t) => t.id === focused) ? focused : active;

  return (
    <div className="flex h-full items-center gap-1 pr-2 pl-2" onClick={() => menu && setMenu(null)}>
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        {/* Tabs share the row the way Chrome's do: each starts at a
            comfortable width and they shrink together as more open, down to
            a favicon alone. The list itself shrinks with them, so whatever
            they leave is the window's drag area. */}
        <div
          className="flex min-w-0 shrink items-center gap-1"
          role="tablist"
          ref={tablistRef}
          aria-label="Tabs"
          onKeyDown={(e) => {
            const next = roveTab(e.key, e.currentTarget, e.target);
            if (!next) return;
            e.preventDefault();
            next.focus();
          }}
        >
          {tabs.map((t) => (
            <SortableTab
              key={t.id}
              tab={t}
              active={t.id === active}
              loading={loading[t.id] === true}
              detached={detached.includes(t.id)}
              narrow={narrow}
              inTabOrder={t.id === stop || (stop === null && t === tabs[0])}
              onFocus={() => setFocused(t.id)}
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

/**
 * Where focus goes for an arrow, Home or End pressed on a tab: the tab in
 * that direction, wrapping at the ends. Null for any other key or when the
 * key was pressed somewhere other than a tab, such as its close button.
 */
export function roveTab(key: string, list: HTMLElement, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") return null;
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
  const i = tabs.indexOf(target);
  if (i === -1 || tabs.length === 0) return null;
  const last = tabs.length - 1;
  const j = key === "ArrowRight" ? (i === last ? 0 : i + 1) : key === "ArrowLeft" ? (i === 0 ? last : i - 1) : key === "Home" ? 0 : key === "End" ? last : -1;
  return j === -1 ? null : (tabs[j] ?? null);
}

/** Below this width a tab drops its close button, and below the second its title, like Chrome's. */
const CLOSE_MIN = 88;
const TITLE_MIN = 56;

/**
 * Every unpinned tab is the same width, so watching one is enough to know
 * whether they have all become too narrow for a close button or a title.
 * Measured rather than a container query: size containment on a flex item
 * zeroes its intrinsic width, and the strip then collapsed to icons even
 * with the whole row free.
 */
function useNarrowTabs(count: number): [React.RefObject<HTMLDivElement | null>, Narrow] {
  const ref = useRef<HTMLDivElement>(null);
  // Zero means "not laid out" (a hidden strip, or a test DOM), not "narrow".
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const sample = ref.current?.querySelector<HTMLElement>('[role="tab"]:not([data-pinned])');
    if (!sample) return;
    const measure = () => setWidth(sample.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sample);
    return () => ro.disconnect();
  }, [count]);
  return [ref, { close: width > 0 && width < CLOSE_MIN, title: width > 0 && width < TITLE_MIN }];
}

type Narrow = { close: boolean; title: boolean };

function SortableTab({ tab: t, active, loading, detached, narrow, inTabOrder, onFocus, onActivate, onClose, onMenu }: { tab: Tab; active: boolean; loading: boolean; detached: boolean; narrow: Narrow; inTabOrder: boolean; onFocus: () => void; onActivate: () => void; onClose: () => void; onMenu: (x: number, y: number) => void }) {
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
      tabIndex={inTabOrder ? 0 : -1}
      onFocus={onFocus}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onActivate();
      }}
      onAuxClick={(e) => e.button === 1 && onClose()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={`group flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-xs transition-colors ${pinned ? "w-9 shrink-0 justify-center px-0" : `min-w-9 basis-56 max-w-56 shrink ${narrow.title ? "justify-center px-0" : ""}`} ${
        active ? "bg-surface-2 text-ink ring-1 ring-line-2" : "text-ink-2 hover:bg-surface hover:text-ink"
      } ${sleeping || detached ? "opacity-55 hover:opacity-100" : ""}`}
      title={detached ? `${label(t)} (in its own window)` : sleeping ? `${label(t)} (sleeping, click to wake)` : pinned ? label(t) : undefined}
      data-sleeping={sleeping || undefined}
      data-detached={detached || undefined}
      data-pinned={pinned || undefined}
    >
      {/* A pinned tab is icon-only, so the site's own mark is the only thing
          left to tell it apart; the pin itself moves to a corner dot. */}
      <span className="relative grid shrink-0 place-items-center">
        {loading ? (
          <span className="grid place-items-center text-ink-2 motion-safe:animate-spin motion-reduce:animate-none" aria-label="Loading" role="img">
            <Icon icon={Loader2} size={pinned ? 16 : 14} />
          </span>
        ) : (
          <Favicon src={t.favicon} size={pinned ? 16 : 14} />
        )}
        {pinned && (
          <span className="absolute -right-1.5 -bottom-1 grid size-3 place-items-center rounded-full bg-surface-2 text-ink-3" aria-hidden>
            <Icon icon={Pin} size={8} />
          </span>
        )}
      </span>
      {!pinned && !narrow.title && <span className="truncate">{label(t)}</span>}
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
      {!pinned && !narrow.title && (!narrow.close || active) && (
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
