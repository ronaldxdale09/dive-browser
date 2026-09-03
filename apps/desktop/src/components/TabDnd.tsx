import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { ReactNode } from "react";
import { create } from "zustand";
import { useBrowser } from "../store/browser";
import { useLayout } from "../store/layout";
import { useCoversContent } from "../lib/overlay";
import { Favicon } from "./Favicon";
import { orderTabs, tabLabel } from "./TabStrip";

/**
 * One drag context for everything a tab can be dragged onto: another slot in
 * the strip (reorder), a side of the page (split), or nowhere at all, past
 * the window's edge (a window of its own). The strip and the content area
 * both live inside it; the pane headers of a split do too, so a pane can be
 * dragged to the other side.
 */

/** The tab being dragged, for the content area to show its drop zones. */
export const useTabDrag = create<{ dragging: string | null }>(() => ({ dragging: null }));

const ZONE = "zone:";
const PANE = "pane:";

/** Droppable id for the slot before pane `index`; `key` keeps ids unique when two halves share a slot. */
export function zoneId(index: number, key: string) {
  return `${ZONE}${index}:${key}`;
}

/** Draggable id of a split pane's header. */
export function paneId(tab: string) {
  return `${PANE}${tab}`;
}

function tabOf(id: UniqueIdentifier): string {
  const s = String(id);
  return s.startsWith(PANE) ? s.slice(PANE.length) : s;
}

export type DropPlan =
  | { kind: "reorder"; ordered: string[] }
  | { kind: "split"; tab: string; index: number }
  | { kind: "detach"; tab: string; at: { x: number; y: number } }
  | { kind: "none" };

/** How far past the window's edge a drop counts as "out", in px. */
const OUTSIDE = 4;

/** Decide what a drop means. Pure, so the rules are testable. */
export function planDrop(args: {
  dragged: string;
  fromPane: boolean;
  over: string | null;
  ordered: string[];
  pointer: { x: number; y: number } | null;
  viewport: { width: number; height: number };
}): DropPlan {
  const { dragged, fromPane, over, ordered, pointer, viewport } = args;
  const tab = tabOf(dragged);
  if (over?.startsWith(ZONE)) {
    const index = Number(over.slice(ZONE.length).split(":")[0]);
    return Number.isFinite(index) ? { kind: "split", tab, index } : { kind: "none" };
  }
  if (over && !fromPane && over !== tab && ordered.includes(over) && ordered.includes(tab)) {
    return { kind: "reorder", ordered: arrayMove(ordered, ordered.indexOf(tab), ordered.indexOf(over)) };
  }
  if (!over && pointer) {
    const out = pointer.x < -OUTSIDE || pointer.y < -OUTSIDE || pointer.x > viewport.width + OUTSIDE || pointer.y > viewport.height + OUTSIDE;
    if (out) return { kind: "detach", tab, at: pointer };
  }
  return { kind: "none" };
}

/** Zones win wherever the pointer is inside one; otherwise the nearest slot of the same family (strip tabs, or pane headers). */
const collision: CollisionDetection = (args) => {
  const zones = args.droppableContainers.filter((c) => String(c.id).startsWith(ZONE));
  const within = pointerWithin({ ...args, droppableContainers: zones });
  if (within.length) return within;
  const fromPane = String(args.active.id).startsWith(PANE);
  if (fromPane) return [];
  const strip = args.droppableContainers.filter((c) => !String(c.id).startsWith(ZONE) && !String(c.id).startsWith(PANE));
  return closestCenter({ ...args, droppableContainers: strip });
};

function pointerAt(e: DragEndEvent): { x: number; y: number } | null {
  const start = e.activatorEvent as PointerEvent | MouseEvent | null;
  if (!start || typeof start.clientX !== "number") return null;
  return { x: start.clientX + e.delta.x, y: start.clientY + e.delta.y };
}

export function TabDnd({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dragging = useTabDrag((s) => s.dragging);
  const tabs = useBrowser((s) => s.tabs);
  // The page is a native view above the chrome, so the drop zones drawn
  // over it can only be seen while it is hidden.
  useCoversContent(dragging !== null);
  const ghost = dragging ? tabs.find((t) => t.id === dragging) : undefined;

  const onDragStart = (e: DragStartEvent) => useTabDrag.setState({ dragging: tabOf(e.active.id) });

  const onDragEnd = (e: DragEndEvent) => {
    useTabDrag.setState({ dragging: null });
    const browser = useBrowser.getState();
    const plan = planDrop({
      dragged: String(e.active.id),
      fromPane: String(e.active.id).startsWith(PANE),
      over: e.over ? String(e.over.id) : null,
      ordered: orderTabs(browser.tabs).map((t) => t.id),
      pointer: pointerAt(e),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    void apply(plan);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={collision} autoScroll={false} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => useTabDrag.setState({ dragging: null })}>
      {children}
      <DragOverlay dropAnimation={null}>
        {ghost && (
          <div className="flex h-8 max-w-56 items-center gap-2 rounded-lg border border-line-2 bg-surface-2 px-2.5 text-xs text-ink shadow-xl">
            <Favicon src={ghost.favicon} size={14} />
            <span className="truncate">{tabLabel(ghost)}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** Carry a drop plan out against the stores. */
export async function apply(plan: DropPlan) {
  const browser = useBrowser.getState();
  switch (plan.kind) {
    case "reorder":
      await browser.reorderTabs(plan.ordered);
      return;
    case "split": {
      const ws = browser.activeWorkspace;
      if (!ws) return;
      if (browser.detached.includes(plan.tab)) await browser.attachTab(plan.tab);
      useLayout.getState().insert(ws, plan.tab, plan.index, browser.activeTab);
      if (browser.activeTab !== plan.tab) await browser.activateTab(plan.tab);
      return;
    }
    case "detach":
      await browser.detachTab(plan.tab, plan.at);
      return;
    case "none":
      return;
  }
}
