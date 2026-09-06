import type { Tab } from "./ipc";

/** Sort for display: pinned first, then by position. Sleeping (discarded)
 * tabs stay in the strip so one click wakes them. Essentials have a rail of
 * their own (see `essentialTabs`). */
export function orderTabs(tabs: Tab[]): Tab[] {
  return tabs
    .filter((t) => t.tier !== "essential")
    .sort((a, b) => (a.tier === b.tier ? a.position - b.position : a.tier === "pinned" ? -1 : 1));
}

/** The essentials, in position order: the tabs every workspace shows. */
export function essentialTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((t) => t.tier === "essential").sort((a, b) => a.position - b.position);
}
