import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { PrivacyEvent, PrivacyInfo } from "../lib/ipc";

export interface PrivacyCounts {
  ads: number;
  trackers: number;
  youtube: number;
}

const EMPTY_COUNTS: PrivacyCounts = { ads: 0, trackers: 0, youtube: 0 };
const MAX = Number.MAX_SAFE_INTEGER;

interface PrivacyState {
  byTab: Record<string, PrivacyCounts>;
  info: PrivacyInfo | null;
  infoError: string | null;
  eventError: string | null;
  apply: (event: PrivacyEvent) => void;
  loadInfo: () => Promise<void>;
  clearPrivacy: (tabId: string) => void;
  drop: (tabId: string) => void;
}

function capped(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? MAX : 0;
  return Math.min(MAX, Math.max(0, Math.floor(value)));
}

/** Fold a single privacy action into its tab's independent summary. */
export function foldPrivacy(counts: PrivacyCounts | undefined, event: PrivacyEvent): PrivacyCounts {
  const current = counts ?? EMPTY_COUNTS;
  if (event.type === "youtube") return { ...current, youtube: capped(current.youtube + capped(event.data.count)) };
  return event.data.category === "ads"
    ? { ...current, ads: capped(current.ads + 1) }
    : { ...current, trackers: capped(current.trackers + 1) };
}

let infoLoading: Promise<void> | null = null;

export const usePrivacy = create<PrivacyState>((set) => ({
  byTab: {},
  info: null,
  infoError: null,
  eventError: null,
  apply: (event) => set((s) => ({ byTab: { ...s.byTab, [event.data.tab_id]: foldPrivacy(s.byTab[event.data.tab_id], event) } })),
  loadInfo: () => {
    if (usePrivacy.getState().info) return Promise.resolve();
    if (infoLoading) return infoLoading;
    const request = ipc
      .privacyInfo()
      .then((info) => {
        usePrivacy.setState({ info, infoError: null });
      })
      .catch((error: unknown) => {
        usePrivacy.setState({ info: null, infoError: errorMessage(error) });
        throw error;
      })
      .finally(() => {
        if (infoLoading === request) infoLoading = null;
      });
    infoLoading = request;
    return infoLoading;
  },
  clearPrivacy: (tabId) => set((s) => {
    if (!(tabId in s.byTab)) return s;
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  }),
  drop: (tabId) => set((s) => {
    if (!(tabId in s.byTab)) return s;
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  }),
}));

let listening: Promise<() => void> | null = null;

/** Subscribe once to privacy actions emitted by the engine. */
export function listenPrivacy() {
  if (listening) return listening;
  const request = events.privacyEvent
    .listen((e) => usePrivacy.getState().apply(e.payload))
    .then((unlisten) => {
      usePrivacy.setState({ eventError: null });
      return unlisten;
    })
    .catch((error: unknown) => {
      usePrivacy.setState({ eventError: errorMessage(error) });
      if (listening === request) listening = null;
      throw error;
    });
  listening = request;
  return listening;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clear this tab's summary when its document starts over. */
export function clearPrivacy(tabId: string) {
  usePrivacy.getState().clearPrivacy(tabId);
}

export const selectPrivacyCounts = (tabId: string | null) => (state: PrivacyState): PrivacyCounts =>
  tabId ? (state.byTab[tabId] ?? EMPTY_COUNTS) : EMPTY_COUNTS;
