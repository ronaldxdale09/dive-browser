import type { Tab } from "./ipc";
import { MAX_PANES } from "../store/layout";
import type { Split } from "../store/layout";

// Pure helpers about how a tab is named and what split view offers it. They
// live here, not in the strip, so the palette's tab actions and the menu share
// one rule without lib/ importing a component.

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

/** Hover text when the strip has squeezed the title away. */
export function tabHoverTitle(t: Tab, detached = false): string {
  const name = tabLabel(t);
  if (detached) return `${name} (in its own window)`;
  if (t.state === "discarded") return `${name} (sleeping, click to wake)`;
  return name;
}

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
  const name = (t: Tab) => `Split with “${shorten(tabLabel(t))}”`;
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

export function shorten(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
