import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AppWindow, Columns2, CopyPlus, Link, Loader2, Moon, Pin, Plus, Star, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBrowser } from "../store/browser";
import { MAX_PANES, useLayout, type Split } from "../store/layout";
import type { Tab } from "../lib/ipc";
import { Favicon } from "./Favicon";
import { Icon, IconButton } from "./Icon";
import { useCoversContent } from "../lib/overlay";
import { chordsByCommand, formatChord } from "../lib/commands";
import { clampFloatingPosition } from "../lib/floating";
import { essentialTabs, orderTabs } from "../lib/tabOrder";

export { essentialTabs, orderTabs };

/**
 * What a tab is called in the strip: its title, else its host. A new view
 * reports "about:blank" as its title until the first real page commits, so
 * that stands in only while the address is blank too.
 */
export function tabLabel(t: Tab) {
  if (t.title && (t.title !== "about:blank" || t.url === "about:blank")) return t.title;
  try {
    return new URL(t.url).host || t.url;
  } catch {
    return t.url;
  }
}
const label = tabLabel;

/** What the tab menu offers for split view, if anything. */
export type SplitAction =
  /** The tab is already a pane: take it out. */
  | { kind: "leave" }
  /** Put `tab` beside `partner`: a new split with the two, or a pane added to the existing one. */
  | { kind: "with"; partner: Tab; index: number; anchor: string; label: string };

/**
 * Split view from the menu: an inactive tab splits with the active one,
 * the active tab splits with its neighbour, and a tab that is already a
 * pane can leave. While a split is showing, another tab joins it at the
 * end. Tabs in their own window cannot be panes.
 */
export function splitAction(tab: Tab, active: string | null, split: Split | undefined, ordered: Tab[], detached: string[]): SplitAction | null {
  if (detached.includes(tab.id)) return null;
  const live = (split?.tabs ?? []).filter((id) => ordered.some((t) => t.id === id) && !detached.includes(id));
  if (live.includes(tab.id)) return { kind: "leave" };
  const name = (t: Tab) => `Split with “${shorten(label(t))}”`;
  if (live.length >= 2) {
    if (live.length >= MAX_PANES) return null;
    const partner = ordered.find((t) => t.id === live[live.length - 1]);
    return partner ? { kind: "with", partner, index: live.length, anchor: live[0]!, label: "Add to split view" } : null;
  }
  const current = ordered.find((t) => t.id === active);
  if (!current || detached.includes(current.id)) return null;
  if (current.id !== tab.id) return { kind: "with", partner: current, index: 1, anchor: current.id, label: name(current) };
  const usable = ordered.filter((t) => t.tier !== "pinned" && !detached.includes(t.id));
  const at = usable.findIndex((t) => t.id === tab.id);
  const partner = usable[at + 1] ?? usable[at - 1];
  return partner ? { kind: "with", partner, index: 1, anchor: tab.id, label: name(partner) } : null;
}

function shorten(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
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
  const openTab = useBrowser((s) => s.openTab);
  const toggle = useBrowser((s) => s.toggle);
  const setPinned = useBrowser((s) => s.setPinned);
  const setTier = useBrowser((s) => s.setTier);
  const detachTab = useBrowser((s) => s.detachTab);
  const attachTab = useBrowser((s) => s.attachTab);
  const insertPane = useLayout((s) => s.insert);
  const removePane = useLayout((s) => s.remove);
  const split = useLayout((s) => (workspace ? s.splits[workspace] : undefined));
  const loading = useBrowser((s) => s.loading);
  const tabs = useMemo(() => orderTabs(all), [all]);
  const paneIds = new Set((split?.tabs ?? []).filter((id) => !detached.includes(id)));
  const essentials = useMemo(() => essentialTabs(all), [all]);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [tablistRef, narrow] = useNarrowTabs(tabs.length);
  const hidden = useHiddenTabs(tablistRef, tabs.length, active);
  // Roving tabindex: one tab is in the Tab order at a time, the focused one
  // if any, else the active one. The arrow keys move focus without activating.
  const [focused, setFocused] = useState<string | null>(null);
  // Stable per-id handlers so a memoised tab only re-renders when its own
  // props change, not when a sibling starts loading.
  const onTabFocus = useCallback((id: string) => setFocused(id), []);
  const onTabActivate = useCallback((id: string) => void activate(id), [activate]);
  const onTabClose = useCallback((id: string) => void close(id), [close]);
  const onTabMenu = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);
  const stop = tabs.some((t) => t.id === focused) ? focused : active;

  return (
    <div className="flex h-full items-center gap-[var(--ui-gap)] pr-2 pl-2" onClick={() => menu && setMenu(null)}>
      {essentials.length > 0 && (
        <>
          {/* Essentials: icon-only and present in every workspace. Not
              sortable -- their order is the engine's -- and set apart by a
              hairline so they read as a fixture, not the first few tabs. */}
          <div role="tablist" aria-label="Essentials" className="flex shrink-0 items-center gap-1">
            {essentials.map((t) => (
              <EssentialTab
                key={t.id}
                tab={t}
                active={t.id === active}
                loading={loading[t.id] === true}
                onActivate={() => void activate(t.id)}
                onMenu={(x, y) => setMenu({ id: t.id, x, y })}
              />
            ))}
          </div>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-line-2" aria-hidden data-testid="essentials-divider" />
        </>
      )}
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        {/* Tabs share the row the way Chrome's do: each starts at a
            comfortable intrinsic width and they shrink together as more open, down to
            a favicon alone. The list itself shrinks with them, so whatever
            they leave is the window's drag area. */}
        <div
          // Past the point where every tab is a bare favicon the list
          // scrolls; it must never spill over the feature bar beside it.
          className="scroll-hidden flex min-w-0 shrink items-center gap-1 overflow-x-auto"
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
              inSplit={paneIds.has(t.id) && paneIds.size >= 2}
              narrow={narrow}
              inTabOrder={t.id === stop || (stop === null && t === tabs[0])}
              onFocus={onTabFocus}
              onActivate={onTabActivate}
              onClose={onTabClose}
              onMenu={onTabMenu}
            />
          ))}
        </div>
      </SortableContext>
      <IconButton icon={Plus} label="New tab" onClick={() => toggle("palette", true)} />
      {hidden > 0 && (
        <button
          type="button"
          aria-label={`${hidden} more ${hidden === 1 ? "tab" : "tabs"} out of view. Search tabs`}
          title={`${hidden} more ${hidden === 1 ? "tab" : "tabs"} out of view · Search tabs (${formatChord(chordsByCommand()["tabs.search"] ?? "")})`}
          data-tauri-drag-region="false"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => toggle("palette", true)}
          className="pressable h-6 shrink-0 rounded-full bg-surface-2 px-2 font-mono text-[10.5px] text-ink-2 tabular-nums hover:bg-surface-3 hover:text-ink"
        >
          +{hidden}
        </button>
      )}
      <div className="min-w-3 flex-1 self-stretch" data-tauri-drag-region="true" />
      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          tier={all.find((t) => t.id === menu.id)?.tier ?? "today"}
          detached={detached.includes(menu.id)}
          split={(() => { const t = all.find((x) => x.id === menu.id); return t ? splitAction(t, active, split, tabs, detached) : null; })()}
          onPin={(v) => {
            void setPinned(menu.id, v);
            setMenu(null);
          }}
          onEssential={(v) => {
            void setTier(menu.id, v ? "essential" : "today");
            setMenu(null);
          }}
          onWindow={(out) => {
            void (out ? detachTab(menu.id, null) : attachTab(menu.id));
            setMenu(null);
          }}
          onSplit={(action) => {
            if (workspace) {
              if (action.kind === "leave") removePane(workspace, menu.id);
              else {
                // The menu's tab is one pane; the other is its partner. Whichever
                // is not the anchor is the one inserted beside it.
                const joining = action.anchor === menu.id ? action.partner.id : menu.id;
                insertPane(workspace, joining, action.index, action.anchor);
                void activate(menu.id);
              }
            }
            setMenu(null);
          }}
          onClose={() => {
            void close(menu.id);
            setMenu(null);
          }}
          onDismiss={() => setMenu(null)}
          onDuplicate={() => {
            const t = all.find((x) => x.id === menu.id);
            if (t) void openTab(t.url);
            setMenu(null);
          }}
          onCopy={() => {
            const t = all.find((x) => x.id === menu.id);
            if (t) void copyAddress(t.url);
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
  const close = width > 0 && width < CLOSE_MIN;
  const title = width > 0 && width < TITLE_MIN;
  return [ref, useMemo(() => ({ close, title }), [close, title])];
}

type Narrow = { close: boolean; title: boolean };

/** Which of a scrolling list's children lie wholly or partly outside its viewport. */
/**
 * How many items poke past either edge of the strip. Both are screen-space
 * rectangles: the strip is not positioned, so an item's offsetLeft is
 * measured from the page and every tab past the strip's width from the
 * window's left edge counted as hidden, even with all of them in view.
 */
export function countOutOfView(list: { left: number; right: number }, items: { left: number; right: number }[]): number {
  return items.filter((item) => item.left < list.left - 1 || item.right > list.right + 1).length;
}

/**
 * How many tabs have scrolled out of the strip. The strip hides its
 * scrollbar, so without this a tab past the edge might as well be closed.
 * The active tab is also kept in view whenever it changes.
 */
function useHiddenTabs(ref: React.RefObject<HTMLDivElement | null>, count: number, active: string | null): number {
  const [hidden, setHidden] = useState(0);
  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    const measure = () =>
      setHidden(
        countOutOfView(
          list.getBoundingClientRect(),
          [...list.querySelectorAll<HTMLElement>('[role="presentation"]')].map((el) => el.getBoundingClientRect()),
        ),
      );
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [ref, count]);
  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    const tab = active ? [...list.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.dataset["tabId"] === active) : null;
    // Scroll the strip itself, never scrollIntoView: that also scrolls every
    // scrollable ancestor, and once shifted the whole chrome to the left.
    if (tab) list.scrollLeft = revealScrollLeft({ ...list.getBoundingClientRect(), scrollLeft: list.scrollLeft }, tab.getBoundingClientRect());
  }, [ref, active]);
  return hidden;
}

/** The strip's scrollLeft that brings `tab` fully into view with the least movement. */
export function revealScrollLeft(list: { left: number; right: number; scrollLeft: number }, tab: { left: number; right: number }): number {
  if (tab.left < list.left) return list.scrollLeft - (list.left - tab.left);
  if (tab.right > list.right) return list.scrollLeft + (tab.right - list.right);
  return list.scrollLeft;
}

/**
 * One tab in the strip. Memoised: the strip re-renders on every load-state
 * tick of any tab, and each tab only needs its own boolean.
 */
const SortableTab = memo(function SortableTab({ tab: t, active, loading, detached, inSplit, narrow, inTabOrder, onFocus: focusTab, onActivate: activateTab, onClose: closeTab, onMenu: openMenu }: { tab: Tab; active: boolean; loading: boolean; detached: boolean; inSplit: boolean; narrow: Narrow; inTabOrder: boolean; onFocus: (id: string) => void; onActivate: (id: string) => void; onClose: (id: string) => void; onMenu: (id: string, x: number, y: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  const onFocus = () => focusTab(t.id);
  const onActivate = () => activateTab(t.id);
  const onClose = () => closeTab(t.id);
  const onMenu = (x: number, y: number) => openMenu(t.id, x, y);
  // DragOverlay is the one tab that follows the pointer. The sortable item
  // becomes an invisible placeholder so the strip does not show a second,
  // half-opacity copy moving underneath it.
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : 1 };
  const pinned = t.tier === "pinned";
  const sleeping = t.state === "discarded";
  return (
    <div
      ref={setNodeRef}
      role="presentation"
      style={style}
      data-tauri-drag-region="false"
      onMouseDown={(e) => e.stopPropagation()}
      onAuxClick={(e) => e.button === 1 && onClose()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={`tab-item group flex h-[calc(var(--row-h)-4px)] cursor-pointer items-center text-xs transition-colors ${pinned ? "w-9 shrink-0 justify-center" : `min-w-9 w-56 max-w-56 shrink ${narrow.title ? "justify-center" : ""}`} ${sleeping || detached ? "opacity-55 hover:opacity-100" : ""}`}
      data-active={active || undefined}
      title={detached ? `${label(t)} (in its own window)` : sleeping ? `${label(t)} (sleeping, click to wake)` : pinned ? label(t) : undefined}
      data-sleeping={sleeping || undefined}
      data-detached={detached || undefined}
      data-pinned={pinned || undefined}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        data-tab-drag-handle
        data-tab-id={t.id}
        data-tauri-drag-region="false"
        role="tab"
        id={`dive-tab-${t.id}`}
        aria-label={label(t)}
        aria-keyshortcuts={!pinned ? "Delete" : undefined}
        aria-selected={active}
        tabIndex={inTabOrder ? 0 : -1}
        // Tauri installs a document-level mousedown listener for native
        // window movement. Keep the tab gesture inside React so dnd-kit owns
        // it from pointer-down through drop; only the empty filler may move
        // the native window.
        onMouseDown={(e) => e.stopPropagation()}
        onFocus={onFocus}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (e.key === "Delete" && !pinned) {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onActivate();
        }}
        data-sleeping={sleeping || undefined}
        data-detached={detached || undefined}
        data-pinned={pinned || undefined}
        // Icon-only tabs still answer "which one is this?" on hover.
        title={pinned || narrow.title ? label(t) : undefined}
        className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-highlight focus-visible:ring-inset ${pinned || narrow.title ? "justify-center px-0" : "px-2.5"}`}
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
        {inSplit && !detached && !pinned && !narrow.title && (
          <span className="grid shrink-0 place-items-center text-highlight" aria-label="In split view">
            <Icon icon={Columns2} size={11} />
          </span>
        )}
      </button>
      {!pinned && !narrow.title && (!narrow.close || active) && (
        <span
          data-close-tab
          data-tauri-drag-region="false"
          aria-hidden="true"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={`mr-1 grid size-5 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100 ${active ? "opacity-100" : ""}`}
        >
          <Icon icon={X} size={12} />
        </span>
      )}
    </div>
  );
});

/** An essential in the rail: the site's icon, and nothing else, in every workspace. */
function EssentialTab({ tab: t, active, loading, onActivate, onMenu }: { tab: Tab; active: boolean; loading: boolean; onActivate: () => void; onMenu: (x: number, y: number) => void }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onActivate();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={label(t)}
      aria-label={label(t)}
      data-essential
      data-tauri-drag-region="false"
      onMouseDown={(e) => e.stopPropagation()}
      data-active={active || undefined}
      className="tab-item grid h-[calc(var(--row-h)-4px)] w-8 shrink-0 cursor-pointer place-items-center text-xs transition-colors"
    >
      {loading ? (
        <span className="grid place-items-center text-ink-2 motion-safe:animate-spin motion-reduce:animate-none" aria-label="Loading" role="img">
          <Icon icon={Loader2} size={16} />
        </span>
      ) : (
        <Favicon src={t.favicon} size={16} />
      )}
    </div>
  );
}

/** Put a page address on the clipboard and say so; the notice names the failure if the OS refuses. */
async function copyAddress(url: string) {
  const { notify } = useBrowser.getState();
  try {
    await navigator.clipboard.writeText(url);
    notify("Copied the address");
  } catch {
    notify("Could not copy: the clipboard is not available.");
  }
}

/** The menu item that focus should move to for an arrow, Home or End key; null for other keys. */
export function roveMenu(key: string, items: readonly HTMLElement[], current: Element | null): HTMLElement | null {
  if (items.length === 0) return null;
  const at = items.findIndex((el) => el === current);
  switch (key) {
    case "ArrowDown":
      return items[(at + 1) % items.length] ?? null;
    case "ArrowUp":
      return items[(at <= 0 ? items.length : at) - 1] ?? null;
    case "Home":
      return items[0] ?? null;
    case "End":
      return items[items.length - 1] ?? null;
    default:
      return null;
  }
}

function TabMenu({ x, y, tier, detached, split, onPin, onEssential, onWindow, onSplit, onClose, onCloseOthers, onDuplicate, onCopy, onDismiss }: { x: number; y: number; tier: Tab["tier"]; detached: boolean; split: SplitAction | null; onPin: (v: boolean) => void; onEssential: (v: boolean) => void; onWindow: (out: boolean) => void; onSplit: (action: SplitAction) => void; onClose: () => void; onCloseOthers: () => void; onDuplicate: () => void; onCopy: () => void; onDismiss: () => void }) {
  useCoversContent(true);
  const ref = useRef<HTMLDivElement>(null);
  // Like every other menu: a press anywhere else or Escape puts it away.
  // Focus lands on the first item so the arrow keys walk the list, and goes
  // back to where it came from when the menu closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
        return;
      }
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      const next = roveMenu(e.key, items, document.activeElement);
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [onDismiss]);
  const pinned = tier === "pinned";
  const essential = tier === "essential";
  const item = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink";
  const chords = chordsByCommand();
  const rows = 6 + (essential ? 0 : 1) + (split ? 1 : 0);
  const position = clampFloatingPosition({ x, y, width: 208, height: 12 + rows * 30 + 2 * 9, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
  return (
    <div ref={ref} role="menu" aria-label="Tab actions" style={{ left: position.x, top: position.y }} className="surface-enter fixed z-50 w-52 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
      {!essential && (
        <button type="button" role="menuitem" className={item} aria-keyshortcuts={chords["tab.pin"]} onClick={() => onPin(!pinned)}>
          <Icon icon={Pin} size={13} /> {pinned ? "Unpin tab" : "Pin tab"}
          <MenuChord chord={chords["tab.pin"]} />
        </button>
      )}
      <button type="button" role="menuitem" className={item} onClick={() => onEssential(!essential)}>
        <Icon icon={Star} size={13} /> {essential ? "Remove from essentials" : "Make essential"}
      </button>
      <div className="my-1 h-px bg-line" role="separator" />
      {split && (
        <button type="button" role="menuitem" className={item} onClick={() => onSplit(split)}>
          <Icon icon={Columns2} size={13} /> <span className="truncate">{split.kind === "leave" ? "Remove from split view" : split.label}</span>
        </button>
      )}
      <button type="button" role="menuitem" className={item} aria-keyshortcuts={chords["tab.detach"]} onClick={() => onWindow(!detached)}>
        <Icon icon={AppWindow} size={13} /> {detached ? "Move back to this window" : "Open in new window"}
        <MenuChord chord={chords["tab.detach"]} />
      </button>
      <div className="my-1 h-px bg-line" role="separator" />
      <button type="button" role="menuitem" className={item} onClick={onDuplicate}>
        <Icon icon={CopyPlus} size={13} /> Duplicate tab
      </button>
      <button type="button" role="menuitem" className={item} onClick={onCopy}>
        <Icon icon={Link} size={13} /> Copy address
      </button>
      <div className="my-1 h-px bg-line" role="separator" />
      <button type="button" role="menuitem" className={item} aria-keyshortcuts={chords["tab.close"]} onClick={onClose}>
        <Icon icon={X} size={13} /> Close tab
        <MenuChord chord={chords["tab.close"]} />
      </button>
      <button type="button" role="menuitem" className={item} onClick={onCloseOthers}>
        <Icon icon={X} size={13} /> Close other tabs
      </button>
    </div>
  );
}

/**
 * The chord on the right of a menu row, in the glyphs the main menu uses.
 * Hidden from the accessible name: the button carries it as aria-keyshortcuts.
 */
function MenuChord({ chord }: { chord: string | undefined }) {
  if (!chord) return null;
  return (
    <kbd aria-hidden="true" className="ml-auto pl-3 font-mono text-[11px] text-ink-3">
      {formatChord(chord)}
    </kbd>
  );
}
