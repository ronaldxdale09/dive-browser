import { useDraggable, useDroppable } from "@dnd-kit/core";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { useContentPreview } from "../lib/overlay";
import type { Tab } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { MAX_PANES, MIN_PANE, useLayout, type Split } from "../store/layout";
import { Favicon } from "./Favicon";
import { Icon } from "./Icon";
import { paneId, zoneId } from "./TabDnd";
import { shorten, tabLabel } from "./TabStrip";
import { isWindows } from "../lib/commands";
import { RESIZE_GUTTER, useWindowMaximized } from "../lib/windowResize";

const GAP = 6;

/** Grid columns for pane fractions with a divider between each pair. */
function columns(sizes: number[]) {
  return sizes.map((s) => `minmax(0,${s}fr)`).join(` ${GAP}px `);
}

/**
 * Two to four pages side by side. Each pane is a header the chrome draws and
 * a body the native view is placed over; the bodies report their rectangles
 * and the engine puts every pane's page where its body is.
 */
export function SplitView({ split, workspace }: { split: Split; workspace: string }) {
  const tabs = useBrowser((s) => s.tabs);
  const active = useBrowser((s) => s.activeTab);
  const activate = useBrowser((s) => s.activateTab);
  const remove = useLayout((s) => s.remove);
  const resize = useLayout((s) => s.resize);
  const root = useRef<HTMLDivElement>(null);
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live ?? split.sizes;

  const register = useCallback((tab: string, el: HTMLDivElement | null) => {
    if (el) bodies.current.set(tab, el);
    else bodies.current.delete(tab);
  }, []);

  const maximized = useWindowMaximized();
  const inset = isWindows() && !maximized ? RESIZE_GUTTER : 0;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let raf = 0;
    const report = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const panes = split.tabs.flatMap((tab, i) => {
          const body = bodies.current.get(tab);
          if (!body) return [];
          const r = body.getBoundingClientRect();
          const isRightmost = i === split.tabs.length - 1;
          const width = inset && isRightmost ? Math.max(1, r.width - inset) : r.width;
          const height = inset ? Math.max(1, r.height - inset) : r.height;
          return [{ tab, bounds: { x: r.left, y: r.top, width, height } }];
        });
        void ipc.setPanes(panes).catch(() => undefined);
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    for (const body of bodies.current.values()) ro.observe(body);
    window.addEventListener("resize", report);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [split.tabs, inset]);

  // Leaving the split returns the engine to a single page.
  useEffect(() => () => void ipc.setPanes([]).catch(() => undefined), []);

  const startResize = (i: number, e: React.PointerEvent<HTMLDivElement>) => {
    const width = root.current?.getBoundingClientRect().width ?? 0;
    if (!width) return;
    const startX = e.clientX;
    const base = [...split.sizes];
    const first = base[i] ?? 0;
    const pair = first + (base[i + 1] ?? 0);
    let next = base;
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) / width;
      const left = Math.min(Math.max(first + delta, MIN_PANE), pair - MIN_PANE);
      next = base.map((s, j) => (j === i ? left : j === i + 1 ? pair - left : s));
      setLive(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      resize(workspace, next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Arrow keys on a divider move it a step, for anyone who does not drag.
  const nudge = (i: number, direction: 1 | -1) => resize(workspace, nudgedSizes(split.sizes, i, direction));

  return (
    <div ref={root} role="group" aria-label="Split view" className="grid min-h-0 min-w-0 bg-ground p-1" style={{ gridTemplateColumns: columns(sizes) }}>
      {split.tabs.map((id, i) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return null;
        const next = tabs.find((t) => t.id === split.tabs[i + 1]);
        return (
          <PaneAndDivider
            key={id}
            tab={tab}
            active={id === active}
            last={i === split.tabs.length - 1}
            divider={{ label: next ? `Resize “${shorten(tabLabel(tab))}” and “${shorten(tabLabel(next))}”` : "Resize panes", share: sizes[i] ?? 0, pair: (sizes[i] ?? 0) + (sizes[i + 1] ?? 0) }}
            onActivate={() => void activate(id)}
            onClose={() => remove(workspace, id)}
            onResize={(e) => startResize(i, e)}
            onNudge={(direction) => nudge(i, direction)}
            register={(el) => register(id, el)}
          />
        );
      })}
    </div>
  );
}

/** How much a divider moves per arrow key, as a fraction of the split. */
export const NUDGE = 0.05;

/** The sizes after divider `i` moves one step right (1) or left (-1). Pure, so it is testable without a DOM. */
export function nudgedSizes(sizes: number[], i: number, direction: 1 | -1): number[] {
  const first = sizes[i] ?? 0;
  const pair = first + (sizes[i + 1] ?? 0);
  // Rounded to a thousandth so repeated steps do not drift into float noise.
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const left = round(Math.min(Math.max(first + direction * NUDGE, MIN_PANE), pair - MIN_PANE));
  return sizes.map((s, j) => (j === i ? left : j === i + 1 ? round(pair - left) : s));
}

type Divider = { label: string; share: number; pair: number };

function PaneAndDivider({ tab, active, last, divider, onActivate, onClose, onResize, onNudge, register }: { tab: Tab; active: boolean; last: boolean; divider: Divider; onActivate: () => void; onClose: () => void; onResize: (e: React.PointerEvent<HTMLDivElement>) => void; onNudge: (direction: 1 | -1) => void; register: (el: HTMLDivElement | null) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: paneId(tab.id) });
  const preview = useContentPreview(tab.id);
  return (
    <>
      <section aria-label={tabLabel(tab)} aria-current={active ? "true" : undefined} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border ${active ? "border-line-2" : "border-line"} ${isDragging ? "opacity-50" : ""}`}>
        <header ref={setNodeRef} {...attributes} {...listeners} onClick={onActivate} className={`flex h-7 shrink-0 cursor-grab items-center gap-2 px-2 text-[11px] ${active ? "bg-surface-2 text-ink shadow-[inset_0_2px_0_var(--color-highlight)]" : "bg-surface text-ink-2"}`}>
          <Favicon src={tab.favicon} size={12} />
          <span className="min-w-0 flex-1 truncate">{tabLabel(tab)}</span>
          <button
            type="button"
            aria-label={`Close pane ${tabLabel(tab)}`}
            title="Close pane (the tab stays open)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink"
          >
            <Icon icon={X} size={11} />
          </button>
        </header>
        <div ref={register} className="relative min-h-0 flex-1 bg-surface">
          {preview && <img aria-hidden src={preview} className="pointer-events-none absolute inset-0 size-full object-fill" />}
        </div>
      </section>
      {!last && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={divider.label}
          aria-valuenow={Math.round((divider.share / Math.max(divider.pair, 0.0001)) * 100)}
          aria-valuemin={Math.round((MIN_PANE / Math.max(divider.pair, 0.0001)) * 100)}
          aria-valuemax={100 - Math.round((MIN_PANE / Math.max(divider.pair, 0.0001)) * 100)}
          aria-valuetext={`${Math.round((divider.share / Math.max(divider.pair, 0.0001)) * 100)}% to the left pane`}
          onPointerDown={onResize}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            onNudge(e.key === "ArrowRight" ? 1 : -1);
          }}
          className="cursor-col-resize rounded-full outline-none hover:bg-line-2 focus-visible:bg-highlight"
          style={{ width: GAP }}
        />
      )}
    </>
  );
}

/**
 * Where a dragged tab can land on the page: the left or right half of each
 * pane (or of the single page), each standing for the slot on that side.
 * Drawn only while a tab is dragged, above its native page.
 */
export function DropZones({ dragging, split, activeTab }: { dragging: string; split: Split | null; activeTab: string | null }) {
  const panes = split?.tabs ?? (activeTab ? [activeTab] : []);
  const sizes = split?.sizes ?? [1];
  const inSplit = panes.includes(dragging);
  if (panes.length === 0) return null;
  // Nothing to split with: the only page is the one being dragged.
  if (!split && dragging === activeTab) return null;
  if (!inSplit && panes.length >= MAX_PANES) return null;
  return (
    <div data-native-overlay aria-hidden className="pointer-events-auto absolute inset-0 z-10 grid bg-ground p-1" style={{ gridTemplateColumns: columns(sizes) }}>
      {panes.map((tab, i) => (
        <div key={tab} className="grid grid-cols-2" style={{ gridColumn: i === 0 ? 1 : 2 * i + 1 }}>
          <Zone index={i} keyName={`${tab}:l`} side="left" />
          <Zone index={i + 1} keyName={`${tab}:r`} side="right" />
        </div>
      ))}
    </div>
  );
}

function Zone({ index, keyName, side }: { index: number; keyName: string; side: "left" | "right" }) {
  const { setNodeRef, isOver } = useDroppable({ id: zoneId(index, keyName) });
  return (
    <div ref={setNodeRef} className={`p-1 ${side === "left" ? "pr-0.5" : "pl-0.5"}`}>
      <div className={`tab-drop-zone grid h-full place-items-center rounded-lg border-2 border-dashed text-xs transition-[border-color,background-color,color,transform] duration-150 ${isOver ? "scale-[0.992] border-highlight bg-highlight-soft text-ink" : "border-line-2 text-ink-3"}`}>{side === "left" ? "Open on the left" : "Open on the right"}</div>
    </div>
  );
}
