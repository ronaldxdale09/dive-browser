import { create } from "zustand";
import { events } from "../lib/ipc";
import type { NetworkEvent } from "../lib/ipc";

const CAP = 1000;

export interface RequestRow {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  mimeType: string;
  fromCache: boolean;
  size: number | null;
  error: string | null;
  startedAt: number;
  durationMs: number | null;
}

interface NetworkState {
  byTab: Record<string, RequestRow[]>;
  apply: (event: NetworkEvent) => void;
  clear: (tabId: string) => void;
  drop: (tabId: string) => void;
}

/** Fold one lifecycle event into the row list. Pure for tests. */
export function fold(rows: RequestRow[] | undefined, event: NetworkEvent): RequestRow[] {
  const list = rows ?? [];
  // specta types f64 as `number | null` (NaN/Infinity serialize as null).
  const at = event.data.timestamp ?? 0;
  if (event.type === "sent") {
    const d = event.data;
    const row: RequestRow = {
      id: d.request_id, url: d.url, method: d.method, resourceType: d.resource_type,
      status: null, mimeType: "", fromCache: false, size: null, error: null, startedAt: at, durationMs: null,
    };
    // Redirects reuse the request id; replace in place so the row shows the final hop.
    const idx = list.findIndex((r) => r.id === row.id);
    const next = idx === -1 ? [...list, row] : list.map((r, i) => (i === idx ? { ...row, startedAt: r.startedAt } : r));
    return next.length > CAP ? next.slice(next.length - CAP) : next;
  }
  const idx = list.findIndex((r) => r.id === event.data.request_id);
  if (idx === -1) return list;
  const row = list[idx]!;
  const durationMs = Math.max(0, Math.round((at - row.startedAt) * 1000));
  let patch: Partial<RequestRow>;
  switch (event.type) {
    case "response":
      patch = { status: event.data.status, mimeType: event.data.mime_type, fromCache: event.data.from_cache };
      break;
    case "finished":
      patch = { size: event.data.encoded_length ?? 0, durationMs };
      break;
    case "failed":
      patch = { error: event.data.error, durationMs };
      break;
  }
  return list.map((r, i) => (i === idx ? { ...r, ...patch } : r));
}

export const useNetwork = create<NetworkState>((set) => ({
  byTab: {},
  apply: (event) => set((s) => ({ byTab: { ...s.byTab, [event.data.tab_id]: fold(s.byTab[event.data.tab_id], event) } })),
  clear: (tabId) => set((s) => ({ byTab: { ...s.byTab, [tabId]: [] } })),
  drop: (tabId) =>
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    }),
}));

let listening: Promise<() => void> | null = null;

/** Subscribe once to network events from the engine. */
export function listenNetwork() {
  listening ??= events.networkEvent.listen((e) => useNetwork.getState().apply(e.payload));
  return listening;
}

const EMPTY: RequestRow[] = [];
export const selectRequests = (tabId: string | null) => (s: NetworkState) => (tabId ? (s.byTab[tabId] ?? EMPTY) : EMPTY);
