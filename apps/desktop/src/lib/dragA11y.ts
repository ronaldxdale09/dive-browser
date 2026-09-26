import type { Announcements, DraggableAttributes, ScreenReaderInstructions, UniqueIdentifier } from "@dnd-kit/core";

/**
 * dnd-kit's attributes for a drag handle, less what it says to a screen
 * reader. It calls every handle a "sortable" or "draggable", points it at
 * instructions for a keyboard drag this chrome does not offer (it has no
 * keyboard sensor; the tab and workspace menus move things instead), and
 * marks the handle pressed while it is dragged. On a tab or a workspace row
 * all three misdescribe what the element is.
 */
export function quietDragAttributes(attributes: DraggableAttributes): Pick<DraggableAttributes, "role" | "tabIndex" | "aria-disabled"> {
  return { role: attributes.role, tabIndex: attributes.tabIndex, "aria-disabled": attributes["aria-disabled"] };
}

/** No instructions: there is no keyboard drag to explain. */
export const NO_DRAG_INSTRUCTIONS: ScreenReaderInstructions = { draggable: "" };

/**
 * What a pointer drag announces, in names rather than ids. dnd-kit's own
 * announcements read "Draggable item 7f3a… was dropped over droppable area
 * 91bc…", which is worse than silence. `name` turns an id into what the
 * person sees (a tab's title, a workspace's name, a side of the page).
 */
export function dragAnnouncements(name: (id: UniqueIdentifier) => string): Announcements {
  return {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${name(active.id)} is over ${name(over.id)}.` : `${name(active.id)} is no longer over a place to drop it.`),
    onDragEnd: ({ active, over }) => (over ? `${name(active.id)} was dropped on ${name(over.id)}.` : `${name(active.id)} was put down.`),
    onDragCancel: ({ active }) => `Stopped moving ${name(active.id)}.`,
  };
}
