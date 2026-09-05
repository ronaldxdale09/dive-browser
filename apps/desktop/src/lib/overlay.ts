import { useEffect, useSyncExternalStore } from "react";
import { ipc } from "./ipc";

/**
 * The page is a native child webview and those always paint above the chrome
 * webview, so any DOM overlay drawn over the content area would be buried
 * behind it. Overlays declare themselves here and the engine hides the page
 * while at least one of them is on screen.
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
let generation = 0;
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
  let frozen: Awaited<ReturnType<typeof ipc.prepareContentCover>> = [];
  try {
    frozen = await ipc.prepareContentCover();
  } catch {
    // The dialog must remain usable even when a renderer cannot be captured.
  }
  if (depth === 0 || token !== generation) return;
  publish(Object.fromEntries(frozen.map((preview) => [preview.tab_id, preview.data_url])));
  // Let React commit the frozen viewport before removing the native surface.
  await afterPaint();
  if (depth === 0 || token !== generation) return;
  covered = true;
  await ipc.setContentCovered(true).catch(() => undefined);
}

function acquire() {
  depth += 1;
  if (depth !== 1) return;
  generation += 1;
  void cover(generation);
}

function release() {
  depth = Math.max(0, depth - 1);
  if (depth !== 0) return;
  generation += 1;
  const token = generation;
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
}

/** Hide the page for as long as this component is mounted with `active`. */
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
 * How many overlays are holding the page hidden.
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
  generation += 1;
  depth = 0;
  covered = false;
  publish({});
}
