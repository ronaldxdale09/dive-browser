import { focusables } from "./useFocusTrap";

/** How long a removal is waited for. Some rows only go when the host next reports (the task manager samples every few seconds). */
export const REMOVAL_WAIT_MS = 10_000;

/**
 * The rows of a list: its elements marked `data-row`, in document order, or
 * its children when none are marked. Marking is for lists whose rows are not
 * direct children -- history groups its rows under a heading per day.
 */
export function listRows(list: HTMLElement): HTMLElement[] {
  const marked = Array.from(list.querySelectorAll<HTMLElement>("[data-row]"));
  return marked.length > 0 ? marked : (Array.from(list.children) as HTMLElement[]);
}

/**
 * Which row takes over once the row at `index` is gone: the one that slid
 * into its place, else the one above it, else none. Pure, so the rule is
 * testable without a DOM.
 */
export function rowAfterRemoval<T>(rows: readonly T[], index: number): T | null {
  if (rows.length === 0) return null;
  return rows[Math.min(index, rows.length - 1)] ?? null;
}

/** The index of the row holding `el` among its list's rows, or -1. */
export function rowIndexOf(list: HTMLElement | null, el: Element | null): number {
  if (!list || !el) return -1;
  return listRows(list).findIndex((row) => row === el || row.contains(el));
}

/** What a control is called for matching its twin in another row. */
function nameOf(el: HTMLElement): string | null {
  return el.getAttribute("title") ?? (el.textContent?.trim() || null);
}

/**
 * Focus the element itself when it can take focus, else a control inside it:
 * the one named like `like` (the next row's own Remove, so removing several
 * in a row is one key each), else the first.
 */
function focusInto(el: HTMLElement, like: string | null = null): boolean {
  const inside = focusables(el);
  const same = like === null ? undefined : inside.find((c) => nameOf(c) === like);
  const target = el.matches("a[href],button:not([disabled]),input:not([disabled]),[tabindex]") ? el : (same ?? inside[0]);
  if (!target) return false;
  target.focus({ preventScroll: false });
  return document.activeElement === target;
}

/** A heading or panel that is not a control still takes focus when told to, without joining the Tab order. */
function focusFallback(el: HTMLElement) {
  if (focusInto(el)) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

function focusLost(): boolean {
  const now = document.activeElement;
  return now === null || now === document.body || !now.isConnected;
}

/**
 * Keep keyboard focus in place when a row is removed from a list.
 *
 * Deleting the row that held focus drops focus to the body: a screen reader
 * goes silent, and the next Tab starts again from the top of the window,
 * behind the dialog. Call this as the removal is asked for, with the list and
 * the row's index among `listRows(list)`. Once that row has left the page --
 * at once for an optimistic removal, or when the host next reports -- focus
 * goes to the row that took its place, else the one above, else `fallback`
 * (the list's filter or heading). It does nothing if focus has meanwhile gone
 * somewhere on purpose, and gives up after `REMOVAL_WAIT_MS`.
 */
export function focusAfterRemoval(list: HTMLElement | null, index: number, fallback?: HTMLElement | null | (() => HTMLElement | null | undefined)): () => void {
  if (!list || index < 0) return () => undefined;
  const removed = listRows(list)[index];
  if (!removed) return () => undefined;
  const scope = list.ownerDocument.body;
  // What the pressed control is called, so its twin in the next row can be found.
  const trigger = document.activeElement instanceof HTMLElement && removed.contains(document.activeElement) ? document.activeElement : null;
  const like = trigger ? nameOf(trigger) : null;
  let done = false;
  const place = () => {
    if (removed.isConnected) return;
    stop();
    if (!focusLost()) return;
    const rows = list.isConnected ? listRows(list) : [];
    const next = rowAfterRemoval(rows, index);
    if (next && focusInto(next, like)) return;
    const home = typeof fallback === "function" ? fallback() : fallback;
    if (home?.isConnected) focusFallback(home);
    else if (list.isConnected) focusFallback(list);
  };
  const observer = new MutationObserver(place);
  const timer = setTimeout(() => stop(), REMOVAL_WAIT_MS);
  function stop() {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(scope, { childList: true, subtree: true });
  return stop;
}

/**
 * `focusAfterRemoval` for the row holding `trigger` (the Remove that was
 * pressed), in the nearest list marked `data-row-list`. Rows rendered by a
 * child component need not be told their index.
 */
export function focusAfterRemovalOf(trigger: Element | null, fallback?: Parameters<typeof focusAfterRemoval>[2]): () => void {
  const list = trigger?.closest<HTMLElement>("[data-row-list]") ?? null;
  return focusAfterRemoval(list, rowIndexOf(list, trigger), fallback);
}
