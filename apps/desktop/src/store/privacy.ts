import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { PrivacyEvent, PrivacyInfo } from "../lib/ipc";
import { errorMessage } from "../lib/errors";

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
  /** Count an event with the next batch rather than at once. */
  enqueue: (event: PrivacyEvent) => void;
  flush: () => void;
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

/** Two summaries added together, each count still capped. */
function addCounts(a: PrivacyCounts | undefined, b: PrivacyCounts): PrivacyCounts {
  const base = a ?? EMPTY_COUNTS;
  return { ads: capped(base.ads + b.ads), trackers: capped(base.trackers + b.trackers), youtube: capped(base.youtube + b.youtube) };
}

let infoLoading: Promise<void> | null = null;

/**
 * Counts waiting to be added, per tab. A page with a few hundred trackers
 * sent one event each, and each was a store update that re-rendered the
 * toolbar's badge; now they land together, a few times a second at most.
 */
const pending = new Map<string, PrivacyCounts>();
const FLUSH_MS = 100;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function cancelPending(tabId: string) {
  pending.delete(tabId);
  if (!pending.size) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
}

export const usePrivacy = create<PrivacyState>((set, get) => ({
  byTab: {},
  info: null,
  infoError: null,
  eventError: null,
  apply: (event) => set((s) => ({ byTab: { ...s.byTab, [event.data.tab_id]: foldPrivacy(s.byTab[event.data.tab_id], event) } })),
  enqueue: (event) => {
    const tabId = event.data.tab_id;
    pending.set(tabId, foldPrivacy(pending.get(tabId), event));
    flushTimer ??= setTimeout(() => get().flush(), FLUSH_MS);
  },
  flush: () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!pending.size) return;
    const changes = new Map(pending);
    pending.clear();
    set((s) => {
      const byTab = { ...s.byTab };
      for (const [tabId, counts] of changes) byTab[tabId] = addCounts(byTab[tabId], counts);
      return { byTab };
    });
  },
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
  clearPrivacy: (tabId) => {
    // Whatever was waiting belonged to the page that was left.
    cancelPending(tabId);
    set((s) => {
      if (!(tabId in s.byTab)) return s;
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    });
  },
  drop: (tabId) => {
    cancelPending(tabId);
    set((s) => {
      if (!(tabId in s.byTab)) return s;
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    });
  },
}));

let listening: Promise<() => void> | null = null;

/** Subscribe once to privacy actions emitted by the engine. */
export function listenPrivacy() {
  if (listening) return listening;
  const request = events.privacyEvent
    .listen((e) => usePrivacy.getState().enqueue(e.payload))
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


/** Clear this tab's summary when its document starts over. */
export function clearPrivacy(tabId: string) {
  usePrivacy.getState().clearPrivacy(tabId);
}

export const selectPrivacyCounts = (tabId: string | null) => (state: PrivacyState): PrivacyCounts =>
  tabId ? (state.byTab[tabId] ?? EMPTY_COUNTS) : EMPTY_COUNTS;
