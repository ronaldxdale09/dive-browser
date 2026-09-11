import { useEffect, useSyncExternalStore } from "react";
import { ipc } from "./ipc";

/**
 * On macOS a native mask lets chrome overlap live content without hiding it.
 * Other runtimes retain the screenshot fallback below.
 * Native page views normally paint above chrome. Overlays register here so
 * the host can raise only their surfaces above live content. The reference
 * count keeps nested overlays covered until the last surface closes.
 *
 * `active` is required rather than defaulting to `true`. A component that
 * renders `null` when it is closed still runs its hooks, so a bare
 * `useCoversContent()` in one of those holds the page hidden for the life of
 * the app -- the whole content area goes black with nothing on screen to
 * explain it. Making the caller state when it covers turns that mistake into
 * a type error.
 */
let depth = 0;
let covered = false;
/** A capture is in flight. Without this a second overlay opening while the
 * first is still capturing would freeze the page twice. */
let covering = false;
let generation = 0;
let stopLive: (() => void) | null = null;
let liveQueue = Promise.resolve();
let liveRevision = 0;
let previews: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: Readonly<Record<string, string>>) {
  previews = next;
  for (const listener of listeners) listener();
}

function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function cover(token: number) {
  covering = true;
  let frozen: Awaited<ReturnType<typeof ipc.prepareContentCover>> = [];
  try {
    frozen = await ipc.prepareContentCover();
  } catch {
    // The dialog must remain usable even when a renderer cannot be captured.
  }
  if (depth === 0 || token !== generation) {
    covering = false;
    return;
  }
  publish(Object.fromEntries(frozen.map((preview) => [preview.tab_id, preview.data_url])));
  // Let React commit the frozen viewport before removing the native surface.
  await afterPaint();
  if (depth === 0 || token !== generation) return;
  covered = true;
  covering = false;
  await ipc.setContentCovered(true).catch(() => undefined);
}

/** macOS uses a native chrome mask; CEF keeps rendering the page beneath it. */
function liveOverlaysAvailable() {
  return (window as Window & { __DIVE_LIVE_OVERLAYS__?: boolean }).__DIVE_LIVE_OVERLAYS__ === true;
}

/**
 * What counts as an overlay, by the role it declares.
 *
 * `alertdialog` is here because a JS `alert()` card is exactly as much an
 * overlay as a dialog, and leaving it out hid every one of them behind the
 * page. `tooltip` likewise. `status` and `alert` are deliberately absent:
 * loading skeletons and inline match counters carry them and are part of the
 * chrome's own layout, not floating over a page.
 */
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-native-overlay]';

/**
 * The overlay elements on screen, cached until the DOM changes shape.
 *
 * The regions are re-measured every frame while an overlay is open, and
 * running the selector over the whole document that often is what made the
 * measurement expensive. Matching elements come and go far less than once a
 * frame, so a mutation observer invalidates the list instead.
 */
let matched: HTMLElement[] | null = null;
let watcher: MutationObserver | null = null;

function overlayElements(): HTMLElement[] {
  if (matched) return matched;
  watcher ??= new MutationObserver(() => { matched = null; });
  watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "data-native-overlay"] });
  matched = Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR))
    .filter((element) => !element.parentElement?.closest(OVERLAY_SELECTOR));
  return matched;
}

/** Drop the cached elements; tests only. */
export function resetOverlayElements() {
  matched = null;
  watcher?.disconnect();
  watcher = null;
}

export function visibleOverlayRegions() {
  return overlayElements()
    // One style read, not two: a `display: none` element measures 0x0 and is
    // dropped by the size filter below, but a hidden one still has a box.
    .filter((element) => getComputedStyle(element).visibility !== "hidden")
    .map((element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; })
    .filter((rect) => rect.width > 0 && rect.height > 0).slice(0, 64);
}

function sendLive(regions: ReturnType<typeof visibleOverlayRegions>, active: boolean) {
  const revision = ++liveRevision;
  liveQueue = liveQueue.catch(() => undefined).then(async () => {
    if (revision !== liveRevision) return;
    await ipc.setOverlayRegions(regions, active);
  });
  // A closed native window may reject an already queued frame.
  void liveQueue.catch(() => undefined);
}

function beginLive() {
  let frame = 0;
  let last = "";
  let stopped = false;
  const update = () => {
    if (stopped) return;
    const regions = visibleOverlayRegions();
    const key = JSON.stringify([window.innerWidth, window.innerHeight, regions]);
    if (key !== last) { last = key; sendLive(regions, true); }
    frame = requestAnimationFrame(update);
  };
  update();
  return () => { stopped = true; cancelAnimationFrame(frame); sendLive([], false); };
}

/**
 * Whether anything on screen right now is a modal dialog.
 *
 * Read from the DOM rather than declared at the call site, so a dialog is
 * treated as one by virtue of saying it is one. Effects run after commit, so
 * by the time an overlay acquires, its element is already here.
 */
function modalIsOpen() {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * Freeze the page rather than keep it live.
 *
 * A modal dims and blurs everything behind it, and neither is possible
 * against a native page view: it is a sibling of the chrome, not part of its
 * compositing, so `backdrop-filter` has nothing to work on and the mask that
 * lets chrome overlap it is a plain rectangle -- which is why a rounded panel
 * used to sit in a square of chrome background. Capturing the page and
 * showing the capture inside the chrome puts those pixels where CSS can
 * reach them, so the blur is real and the corners are the panel's own.
 *
 * Only modals: a menu or a suggestion list must leave the page playing.
 */
function wantsFrozen() {
  return !liveOverlaysAvailable() || modalIsOpen();
}

/** Put the page in whichever state the overlays now on screen call for. */
function sync() {
  if (depth === 0) {
    if (stopLive) {
      stopLive();
      stopLive = null;
    }
    generation += 1;
    const token = generation;
    covering = false;
    if (covered) {
      covered = false;
      void ipc
        .setContentCovered(false)
        .catch(() => undefined)
        .finally(() => {
          // A later overlay may already have captured and covered the page.
          if (depth === 0 && token === generation) publish({});
        });
    } else {
      publish({});
    }
    return;
  }
  if (wantsFrozen()) {
    // A modal opened over a live overlay: drop the mask before capturing, or
    // the capture races a page the chrome is still punching holes through.
    if (stopLive) {
      stopLive();
      stopLive = null;
    }
    if (!covered && !covering) {
      generation += 1;
      void cover(generation);
    }
    return;
  }
  if (!stopLive) {
    generation += 1;
    stopLive = beginLive();
  }
}

function acquire() {
  depth += 1;
  sync();
}

function release() {
  depth = Math.max(0, depth - 1);
  sync();
}

/** Keep chrome overlays above native pages while `active`. */
export function useCoversContent(active: boolean) {
  useEffect(() => {
    if (!active) return;
    acquire();
    return release;
  }, [active]);
}

/** Frozen viewport for `tabId`, present only while chrome covers its native view. */
export function useContentPreview(tabId: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (tabId ? (previews[tabId] ?? null) : null),
    () => null,
  );
}

/**
 * How many overlays currently require chrome above the page.
 *
 * The invariant is that this is zero whenever nothing is on screen over the
 * content area; a non-zero count with no visible overlay is the bug described
 * above, so tests assert on it.
 */
export function contentCoverDepth() {
  return depth;
}

/** Reset the shared counter; tests only. */
export function resetContentCover() {
  stopLive?.();
  stopLive = null;
  generation += 1;
  depth = 0;
  covered = false;
  publish({});
}
