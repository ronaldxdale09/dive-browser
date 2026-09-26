import { ipc } from "./ipc";

/**
 * The chrome's own small state: panel sizes, the chosen subtitles model,
 * cached avatar artwork. The chrome webview runs off-the-record so that
 * extensions cannot reach Dive's interface, which leaves it no web storage
 * of its own; this `Storage` keeps the values in memory and writes them
 * through to the profile store. `loadUiStorage` fills it once at boot.
 */
const entries = new Map<string, string>();
let backed = false;

export const uiStorage: Storage = {
  get length() {
    return entries.size;
  },
  key(index: number) {
    return [...entries.keys()][index] ?? null;
  },
  getItem(key: string) {
    return entries.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    const text = String(value);
    // A persisted store writes itself back on every change to any of its
    // state, not just the part it keeps: the recorder rewrote its settings
    // on each progress tick of a save. Only a value that changed is worth a
    // write to the profile store.
    if (entries.get(key) === text) return;
    entries.set(key, text);
    if (backed) void ipc.uiStateSet(key, text).catch(() => undefined);
  },
  removeItem(key: string) {
    entries.delete(key);
    if (backed) void ipc.uiStateSet(key, null).catch(() => undefined);
  },
  clear() {
    for (const key of [...entries.keys()]) uiStorage.removeItem(key);
  },
};

/** Read every stored value; afterwards writes reach the store. */
export async function loadUiStorage(): Promise<boolean> {
  try {
    const rows = await ipc.uiStateLoad();
    entries.clear();
    for (const [key, value] of rows) entries.set(key, value);
    backed = true;
  } catch {
    backed = false;
  }
  return backed;
}

/** Forget everything and stop writing through; for tests. */
export function resetUiStorage() {
  entries.clear();
  backed = false;
}
