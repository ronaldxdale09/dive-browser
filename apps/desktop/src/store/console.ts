import { create } from "zustand";
import { events } from "../lib/ipc";
import type { ConsoleEntry } from "../lib/ipc";

const CAP = 500;

interface ConsoleState {
  byTab: Record<string, ConsoleEntry[]>;
  push: (entry: ConsoleEntry) => void;
  clear: (tabId: string) => void;
  drop: (tabId: string) => void;
}

/** Append keeping at most CAP entries per tab. Pure for tests. */
export function append(list: ConsoleEntry[] | undefined, entry: ConsoleEntry): ConsoleEntry[] {
  const next = list ? [...list, entry] : [entry];
  return next.length > CAP ? next.slice(next.length - CAP) : next;
}

export const useConsole = create<ConsoleState>((set) => ({
  byTab: {},
  push: (entry) => set((s) => ({ byTab: { ...s.byTab, [entry.tab_id]: append(s.byTab[entry.tab_id], entry) } })),
  clear: (tabId) => set((s) => ({ byTab: { ...s.byTab, [tabId]: [] } })),
  drop: (tabId) =>
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    }),
}));

let listening: Promise<() => void> | null = null;

/** Subscribe once to console events from the engine. */
export function listenConsole() {
  listening ??= events.consoleEntry.listen((e) => useConsole.getState().push(e.payload));
  return listening;
}

const EMPTY: ConsoleEntry[] = [];
export const selectEntries = (tabId: string | null) => (s: ConsoleState) => (tabId ? (s.byTab[tabId] ?? EMPTY) : EMPTY);

/** Favicon fetch failures are browser noise, not the page's problem. */
export function isNoise(e: ConsoleEntry): boolean {
  return e.level === "error" && (e.url?.endsWith("/favicon.ico") === true || e.text.includes("favicon.ico"));
}

/** Errors and exceptions for a tab, newest last. */
export const selectErrors = (tabId: string | null) => (s: ConsoleState) => {
  const list = tabId ? (s.byTab[tabId] ?? EMPTY) : EMPTY;
  return list === EMPTY ? EMPTY : list.filter((e) => e.level === "error" && !isNoise(e));
};

/** Count of error-level entries for a tab; stable primitive for selectors. */
export const selectErrorCount = (tabId: string | null) => (s: ConsoleState) =>
  tabId ? (s.byTab[tabId] ?? EMPTY).reduce((n, e) => (e.level === "error" && !isNoise(e) ? n + 1 : n), 0) : 0;
