import { ipc } from "./ipc";
import { tabInThisWindow, useBrowser } from "../store/browser";

/**
 * The regions F6 and Shift+F6 move the keyboard between, in the order they
 * are walked: the tabs, the workspaces, the toolbar, the feature bar, the
 * developer dock, the agent, a prompt waiting on the page (the save-password
 * card), a notification with something to do, and the page itself.
 *
 * Every browser has this: without it the only way from the page to the
 * chrome is a chord for one particular field, and from the chrome back to
 * the page is Tab through every button on the way.
 */
export type PaneId = "tabs" | "rail" | "toolbar" | "features" | "dock" | "agent" | "prompt" | "notice" | "page";

type ChromePane = {
  id: Exclude<PaneId, "page">;
  /** What counts as being in the pane. */
  region: string;
  /** Where the keyboard lands, tried in order; `null` for the pane's first control. */
  stops: (string | null)[];
};

// Found by the roles and names the regions already carry, so the walk
// follows the chrome's own structure rather than a parallel set of marks.
const PANES: ChromePane[] = [
  {
    id: "tabs",
    region: '[role="tablist"][aria-label="Tabs"], [role="tablist"][aria-label="Essentials"]',
    // The tab in the Tab order is the active one (or the one last focused).
    stops: ['[role="tablist"][aria-label="Tabs"] [role="tab"][tabindex="0"]', '[role="tablist"][aria-label="Essentials"] [role="tab"][tabindex="0"]', '[role="tablist"][aria-label="Tabs"] [role="tab"]'],
  },
  { id: "rail", region: 'nav[aria-label="Workspaces"]', stops: ['nav[aria-label="Workspaces"] [aria-pressed="true"]', null] },
  { id: "toolbar", region: 'nav[aria-label="Browser controls"]', stops: ['nav[aria-label="Browser controls"] input[aria-label="Address"]', null] },
  { id: "features", region: '[data-pane="features"]', stops: [null] },
  { id: "dock", region: 'section[aria-label="Developer dock"]', stops: ['[role="tablist"][aria-label="Dock panels"] [role="tab"][tabindex="0"]', null] },
  { id: "agent", region: 'section[aria-label="Agent"]', stops: ['section[aria-label="Agent"] textarea[aria-label="Message the agent"]', null] },
  // The card itself, not its first button: focusing it says its question,
  // and Tab goes on to the answers.
  { id: "prompt", region: '[data-pane="prompt"]', stops: ['[data-pane="prompt"][tabindex="-1"]', null] },
  { id: "notice", region: '[data-pane="notice"]', stops: [null] },
];

const ORDER: PaneId[] = [...PANES.map((p) => p.id), "page"];

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function usable(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && !el.closest("[hidden], [inert], [aria-hidden='true']");
}

/** Where the keyboard would land in `pane`, or null when the pane is not on screen. */
function stopIn(pane: ChromePane, root: ParentNode): HTMLElement | null {
  for (const stop of pane.stops) {
    if (stop) {
      const el = root.querySelector(stop);
      if (usable(el)) return el;
      continue;
    }
    for (const region of root.querySelectorAll(pane.region)) {
      const first = Array.from(region.querySelectorAll(FOCUSABLE)).find(usable);
      if (first) return first;
    }
  }
  return null;
}

// ---- whether the page has the keyboard ----
// The page is a native view of its own. When it takes the keyboard the
// chrome's window blurs; when the chrome gets it back for a menu command
// (F6 from the page arrives that way) the window focuses again a moment
// before the command. So the page counts as holding the keyboard from the
// blur until the person next presses or clicks in the chrome, unless the
// chrome has been focused for longer than a menu command takes to arrive.
let pageHeld = false;
let chromeFocusedAt = 0;
/** Longer than a menu command takes to follow the focus it asked for. */
const MENU_FOCUS_MS = 500;
let tracking = false;

function trackPageFocus() {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  window.addEventListener("blur", () => {
    pageHeld = true;
  });
  window.addEventListener("focus", () => {
    chromeFocusedAt = performance.now();
  });
  const inChrome = () => {
    pageHeld = false;
  };
  window.addEventListener("pointerdown", inChrome, true);
  window.addEventListener("keydown", inChrome, true);
}
trackPageFocus();

/** Whether the keyboard is on the page rather than in the chrome. */
export function pageHasKeyboard(): boolean {
  if (!document.hasFocus()) return true;
  return pageHeld && performance.now() - chromeFocusedAt < MENU_FOCUS_MS;
}

/** Tests start with the keyboard in the chrome. */
export function resetPageFocus() {
  pageHeld = false;
  chromeFocusedAt = 0;
}

function activeTabHere(): string | null {
  const { activeTab, detached } = useBrowser.getState();
  return tabInThisWindow(activeTab, detached);
}

/** The pane the keyboard is in now, or null when it is in none of them. */
export function currentPane(root: Document = document): PaneId | null {
  if (activeTabHere() && pageHasKeyboard()) return "page";
  const active = root.activeElement;
  if (!active || active === root.body) return null;
  return PANES.find((p) => active.closest(p.region))?.id ?? null;
}

/** The panes that can take the keyboard right now, in walking order. */
export function availablePanes(root: Document = document): PaneId[] {
  return ORDER.filter((id) => (id === "page" ? activeTabHere() !== null : stopIn(PANES.find((p) => p.id === id)!, root) !== null));
}

/** The pane `step` places from `from` among `available`, wrapping; null when there is nowhere to go. */
export function nextPane(available: readonly PaneId[], from: PaneId | null, step: 1 | -1): PaneId | null {
  if (available.length === 0) return null;
  if (from === null) return step === 1 ? available[0]! : available[available.length - 1]!;
  // A pane that has gone (the card was answered) still has a place in the
  // order: the walk goes on from where it was.
  const at = ORDER.indexOf(from);
  const ordered = step === 1 ? [...ORDER.slice(at + 1), ...ORDER.slice(0, at + 1)] : [...ORDER.slice(0, at).reverse(), ...ORDER.slice(at).reverse()];
  return ordered.find((id) => available.includes(id) && id !== from) ?? null;
}

/**
 * F6 and Shift+F6. Inside a modal dialog it does nothing: the dialog holds
 * the keyboard until it is answered, and walking out of it would leave it
 * open behind the page.
 */
export function cyclePane(step: 1 | -1, root: Document = document): PaneId | null {
  const active = root.activeElement;
  if (active?.closest('[aria-modal="true"]') && !pageHasKeyboard()) return null;
  const target = nextPane(availablePanes(root), currentPane(root), step);
  if (!target) return null;
  if (target === "page") {
    const tab = activeTabHere();
    if (tab) {
      pageHeld = true;
      void ipc.tabFocus(tab).catch(() => undefined);
    }
    return target;
  }
  const el = stopIn(PANES.find((p) => p.id === target)!, root);
  if (!el) return null;
  pageHeld = false;
  el.focus();
  return target;
}
