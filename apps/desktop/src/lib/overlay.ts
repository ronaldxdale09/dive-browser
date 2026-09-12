import { useLayoutEffect, useSyncExternalStore } from "react";
import { ipc } from "./ipc";

/**
 * On macOS and Windows a native mask raises chrome without hiding content.
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
    if (liveOverlaysAvailable()) await liveQueue.catch(() => undefined);
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
  if (depth === 0 || token !== generation) {
    // Not resetting `covering` here left the flag stuck true, so no later
    // overlay could ever cover the page again.
    covering = false;
    return;
  }
  covered = true;
  covering = false;
  await ipc.setContentCovered(true).catch(() => undefined);
}

/** Native masks keep CEF rendering the page beneath every chrome overlay. */
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
 * Running the selector over the whole document on every measurement is what
 * made it expensive. Matching elements come and go far less often than the
 * regions are measured, so a mutation observer invalidates the list instead.
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
    .map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      // Floating chrome surfaces use uniform circular corners. Carry their
      // painted shape through IPC; a rectangular native mask exposes the
      // chrome's opaque background in the otherwise transparent corners.
      const style = getComputedStyle(element);
      const radius = Math.min(width / 2, height / 2, ...[
        style.borderTopLeftRadius, style.borderTopRightRadius,
        style.borderBottomRightRadius, style.borderBottomLeftRadius,
      ].map((value) => Number.parseFloat(value || style.borderRadius) || 0));
      return { x, y, width, height, ...(radius > 0 ? { radius } : {}) };
    })
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

/**
 * How long a transition or animation is followed frame by frame after it
 * starts. Its end event normally stops the loop sooner; the cap is for the
 * element that is removed mid-flight and never sends one.
 */
const MOTION_FOLLOW_MS = 500;

/** Attributes whose change can move or resize an overlay without resizing it. */
const MOTION_ATTRIBUTES = ["style", "class", "hidden", "role", "data-native-overlay"];

/**
 * Keep the native mask matched to the overlays on screen.
 *
 * This used to re-measure every frame for as long as anything was open,
 * which meant a tooltip cost a style read, a layout read and a serialise
 * sixty times a second while nothing moved. Overlays only change shape for
 * a reason the DOM reports -- an element resizes, the tree or an attribute
 * changes, the window resizes, something scrolls -- so each of those
 * schedules one measurement. The exception is CSS motion: a transition
 * moves the box every frame and says so only at its start and end, so the
 * frame loop runs between those two events and no longer.
 */
function beginLive() {
  let frame = 0;
  let last = "";
  let stopped = false;
  let motionUntil = 0;
  const measure = () => {
    const regions = visibleOverlayRegions();
    const key = JSON.stringify([window.innerWidth, window.innerHeight, regions]);
    if (key !== last) { last = key; sendLive(regions, true); }
  };
  const onFrame = () => {
    frame = 0;
    if (stopped) return;
    measure();
    if (performance.now() < motionUntil) frame = requestAnimationFrame(onFrame);
  };
  // At most one measurement per frame, however many events ask for it.
  const schedule = () => { if (!frame && !stopped) frame = requestAnimationFrame(onFrame); };
  const onMotionStart = () => { motionUntil = performance.now() + MOTION_FOLLOW_MS; schedule(); };
  // The end event measures once more, at the settled position.
  const onMotionEnd = () => { motionUntil = 0; schedule(); };

  const resizer = new ResizeObserver(schedule);
  const observeOverlays = () => {
    resizer.disconnect();
    for (const element of overlayElements()) resizer.observe(element);
  };
  const mutations = new MutationObserver(() => { observeOverlays(); schedule(); });
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: MOTION_ATTRIBUTES });
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, true);
  for (const type of ["transitionstart", "animationstart"]) document.addEventListener(type, onMotionStart, true);
  for (const type of ["transitionend", "transitioncancel", "animationend", "animationcancel"]) document.addEventListener(type, onMotionEnd, true);
  observeOverlays();
  measure();

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    resizer.disconnect();
    mutations.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
    for (const type of ["transitionstart", "animationstart"]) document.removeEventListener(type, onMotionStart, true);
    for (const type of ["transitionend", "transitioncancel", "animationend", "animationcancel"]) document.removeEventListener(type, onMotionEnd, true);
    sendLive([], false);
  };
}

/** Native overlays stay live where painting and modal input are independent. Capturing a
 * busy renderer before raising a dialog made opening basic browser controls
 * wait for CDP and introduced races between frozen and live cover states. */
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
  const modalNeedsFallback = (window as Window & { __DIVE_LIVE_MODAL_OVERLAYS__?: boolean }).__DIVE_LIVE_MODAL_OVERLAYS__ === false
    && document.querySelector('[aria-modal="true"]') !== null;
  if (!liveOverlaysAvailable() || modalNeedsFallback) {
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
  if (covered) {
    covered = false;
    liveQueue = liveQueue.catch(() => undefined).then(async () => { await ipc.setContentCovered(false); });
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
  // Layout-effect cleanup can precede removal of the modal DOM node.
  if (depth > 0) queueMicrotask(sync);
}

/** Keep chrome overlays above native pages while `active`. */
export function useCoversContent(active: boolean) {
  useLayoutEffect(() => {
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
  covering = false;
  publish({});
}
