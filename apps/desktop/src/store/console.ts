import { create } from "zustand";
import { events } from "../lib/ipc";
import type { ConsoleEntry } from "../lib/ipc";

const CAP = 500;

/** A console entry as kept here: the wire entry plus a key that survives eviction, so a windowed list can reuse rows. */
export interface ConsoleRow extends ConsoleEntry {
  id: number;
}

interface ConsoleState {
  byTab: Record<string, ConsoleRow[]>;
  push: (entry: ConsoleEntry) => void;
  enqueue: (entry: ConsoleEntry) => void;
  flush: () => void;
  clear: (tabId: string) => void;
  drop: (tabId: string) => void;
}

let seq = 0;

/** Append keeping at most CAP entries per tab. Pure for tests. */
export function append(list: ConsoleRow[] | undefined, entry: ConsoleEntry): ConsoleRow[] {
  const row: ConsoleRow = { ...entry, id: ++seq };
  const next = list ? [...list, row] : [row];
  return next.length > CAP ? next.slice(next.length - CAP) : next;
}

const pending = new Map<string, ConsoleRow[]>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function cancelPending(tabId: string) {
  pending.delete(tabId);
  if (!pending.size) { clearTimeout(flushTimer); flushTimer = undefined; }
}

export const useConsole = create<ConsoleState>((set, get) => ({
  byTab: {},
  push: (entry) => {
    get().flush();
    set((s) => ({ byTab: { ...s.byTab, [entry.tab_id]: append(s.byTab[entry.tab_id], entry) } }));
  },
  enqueue: (entry) => {
    let rows = pending.get(entry.tab_id);
    if (!rows) { rows = [...(get().byTab[entry.tab_id] ?? [])]; pending.set(entry.tab_id, rows); }
    rows.push({ ...entry, id: ++seq });
    if (rows.length > CAP) rows.shift();
    flushTimer ??= setTimeout(() => get().flush(), 33);
  },
  flush: () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!pending.size) return;
    const changes = Object.fromEntries(pending);
    pending.clear();
    set((s) => ({ byTab: { ...s.byTab, ...changes } }));
  },
  clear: (tabId) => {
    cancelPending(tabId);
    set((s) => ({ byTab: { ...s.byTab, [tabId]: [] } }));
  },
  drop: (tabId) => {
    cancelPending(tabId);
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    });
  },
}));

let listening: Promise<() => void> | null = null;

/** Subscribe once to console events from the engine. */
export function listenConsole() {
  if (listening) return listening;
  const request = events.consoleEntry.listen((e) => useConsole.getState().enqueue(e.payload)).catch((error: unknown) => {
    if (listening === request) listening = null;
    throw error;
  });
  listening = request;
  return listening;
}

const EMPTY: ConsoleRow[] = [];
/** The tab's entries by reference: an event for another tab leaves this untouched, so subscribers do not re-render. */
export const selectEntries = (tabId: string | null) => (s: ConsoleState) => (tabId ? (s.byTab[tabId] ?? EMPTY) : EMPTY);

/** Favicon fetch failures are browser noise, not the page's problem. */
export function isNoise(e: ConsoleEntry): boolean {
  return e.level === "error" && (e.url?.endsWith("/favicon.ico") === true || e.text.includes("favicon.ico"));
}

/**
 * Errors and exceptions for a tab, newest last. Builds a new array per call, so
 * derive from `selectEntries` with `useMemo` in components rather than passing
 * this to the store hook directly.
 */
export const selectErrors = (tabId: string | null) => (s: ConsoleState) => {
  const list = tabId ? (s.byTab[tabId] ?? EMPTY) : EMPTY;
  return list === EMPTY ? EMPTY : list.filter((e) => e.level === "error" && !isNoise(e));
};

/** Count of error-level entries for a tab; stable primitive for selectors. */
export const selectErrorCount = (tabId: string | null) => (s: ConsoleState) =>
  tabId ? (s.byTab[tabId] ?? EMPTY).reduce((n, e) => (e.level === "error" && !isNoise(e) ? n + 1 : n), 0) : 0;
