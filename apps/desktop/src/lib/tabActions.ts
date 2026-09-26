import { announce } from "./announce";
import type { Tab } from "./ipc";
import { orderTabs } from "./tabOrder";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { useLayout } from "../store/layout";
import { useTabAudio } from "../store/tabAudio";
// The menu's own rule for split view, so the palette and the menu agree on
// what "split" does to a given tab. The command list loads this module only
// when one of these runs, since the strip imports that list in turn.
import { splitAction, tabLabel } from "../components/TabStrip";

/**
 * The tab menu's actions, for the tab in front of you. The menu is reached
 * by a right-click or Shift+F10 on a tab; these are the same actions from
 * the palette and the keyboard, with a word said about what happened.
 */
function activeTab(): Tab | undefined {
  const { tabs, activeTab, detached } = useBrowser.getState();
  const id = tabInThisWindow(activeTab, detached);
  return id ? tabs.find((t) => t.id === id) : undefined;
}

export async function muteActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  const muted = useTabAudio.getState().byTab[tab.id]?.muted === true;
  await useTabAudio.getState().setMuted(tab.id, !muted);
  announce(`${muted ? "Unmuted" : "Muted"} ${tabLabel(tab)}`);
}

export async function duplicateActiveTab() {
  const tab = activeTab();
  if (tab) await useBrowser.getState().duplicateTab(tab.id);
}

export async function essentialActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  const essential = tab.tier === "essential";
  await useBrowser.getState().setTier(tab.id, essential ? "today" : "essential");
  announce(essential ? `${tabLabel(tab)} is no longer an essential` : `${tabLabel(tab)} is now an essential, in every workspace`);
}

export async function closeOtherTabs() {
  const tab = activeTab();
  if (tab) await useBrowser.getState().closeOtherTabs(tab.id);
}

/** Split view from the keyboard: the same choice the tab menu offers for the active tab. */
export function splitActiveTab() {
  const tab = activeTab();
  const { activeWorkspace: workspace, tabs, detached } = useBrowser.getState();
  if (!tab || !workspace) return;
  const layout = useLayout.getState();
  const split = layout.splits[workspace];
  const action = splitAction(tab, tab.id, split, orderTabs(tabs), detached);
  if (!action) {
    announce("This tab cannot be split");
    return;
  }
  if (action.kind === "leave") {
    layout.remove(workspace, tab.id);
    announce("Removed from split view");
    return;
  }
  const joining = action.anchor === tab.id ? action.partner.id : tab.id;
  // Joining the split only when the anchor is one of its panes; otherwise
  // the two tabs start a split of their own.
  const shown = split && split.tabs.includes(action.anchor) ? split : null;
  layout.insert(workspace, joining, action.index, action.anchor, shown);
  announce(shown ? "Added to split view" : `Split with ${tabLabel(action.partner)}`);
}

/**
 * Move the active tab one place left (-1) or right (1) in the strip. It
 * stays among its own kind: a pinned tab moves among the pinned ones, and
 * an unpinned one never jumps in among them, because the strip always draws
 * the pinned first whatever their positions say.
 */
export async function moveActiveTab(step: -1 | 1) {
  const tab = activeTab();
  if (!tab) return;
  if (tab.tier === "essential") {
    announce("Essential tabs keep their order");
    return;
  }
  const ordered = orderTabs(useBrowser.getState().tabs);
  const at = ordered.findIndex((t) => t.id === tab.id);
  const neighbour = ordered[at + step];
  if (at < 0 || !neighbour || neighbour.tier !== tab.tier) {
    announce(step < 0 ? "Already the first tab" : "Already the last tab");
    return;
  }
  const ids = ordered.map((t) => t.id);
  ids.splice(at, 1);
  ids.splice(at + step, 0, tab.id);
  await useBrowser.getState().reorderTabs(ids);
  announce(`Moved to position ${at + step + 1} of ${ids.length}`);
}
