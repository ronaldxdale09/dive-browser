import { useEffect, useSyncExternalStore } from "react";
import { ipc } from "./ipc";

/**
 * Site icons by key. Tabs, history rows and bookmarks carry only the key of
 * their site's icon -- a fingerprint of its bytes -- and the image is read
 * from the host once and kept here for as long as the chrome runs. A tab
 * event used to carry the icon itself, tens of kilobytes per event.
 *
 * Because a key names the bytes, nothing here ever goes stale: a site that
 * changes its icon arrives under a new key.
 */

/** Most keys asked for in one call; the host answers up to this many. */
const BATCH = 64;

/** Images read so far; `null` is a key the host has nothing for. */
const images = new Map<string, string | null>();
/** Keys waiting for the next batch. */
const wanted = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether `src` is a key rather than something an `<img>` can load. Keys
 * are hex; a `data:`, `blob:` or web address always has a colon.
 */
export function isFaviconKey(src: string): boolean {
  return src !== "" && !src.includes(":");
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Ask for `key` with whatever else is asked for in the same tick: a tab strip
 * rendering twenty tabs is one round trip, not twenty.
 */
function request(key: string) {
  if (images.has(key) || wanted.has(key)) return;
  wanted.add(key);
  timer ??= setTimeout(() => void flush(), 0);
}

async function flush() {
  timer = null;
  const keys = [...wanted].slice(0, BATCH);
  if (keys.length < wanted.size) timer = setTimeout(() => void flush(), 0);
  try {
    const found = new Map(await ipc.faviconGet(keys));
    for (const key of keys) images.set(key, found.get(key) ?? null);
  } catch {
    // Left unread, so the next row that shows this key asks again.
  } finally {
    for (const key of keys) wanted.delete(key);
    notify();
  }
}

/**
 * What an `<img>` should load for `src`: the image behind a key once it has
 * been read, `src` itself when it is already a URL, or `null` meanwhile and
 * when there is nothing to show.
 */
export function useFaviconSrc(src: string | null | undefined): string | null {
  const key = src && isFaviconKey(src) ? src : null;
  const image = useSyncExternalStore(subscribe, () => (key ? images.get(key) : undefined));
  useEffect(() => {
    if (key) request(key);
  }, [key]);
  if (!src) return null;
  if (!key) return src;
  return image ?? null;
}

/** Forget every image read so far; for tests. */
export function resetFavicons() {
  images.clear();
  wanted.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
