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

export interface FrameRow {
  direction: "sent" | "received";
  payload: string;
  at: number;
}

const FRAME_CAP = 200;

interface NetworkState {
  byTab: Record<string, RequestRow[]>;
  /** Frames per `${tabId}:${requestId}` for sockets and event streams. */
  frames: Record<string, FrameRow[]>;
  apply: (event: NetworkEvent) => void;
  clear: (tabId: string) => void;
  drop: (tabId: string) => void;
}

/** Fold one lifecycle event into the row list. Pure for tests. */
export function fold(rows: RequestRow[] | undefined, event: NetworkEvent): RequestRow[] {
  const list = rows ?? [];
  // specta types f64 as `number | null` (NaN/Infinity serialize as null).
  const at = event.data.timestamp ?? 0;
  if (event.type === "frame") return list;
  if (event.type === "sent" || event.type === "socket") {
    const base = { status: null, mimeType: "", fromCache: false, size: null, error: null, startedAt: at, durationMs: null };
    const row: RequestRow =
      event.type === "socket"
        ? { ...base, id: event.data.request_id, url: event.data.url, method: "GET", resourceType: "WebSocket", mimeType: "websocket" }
        : { ...base, id: event.data.request_id, url: event.data.url, method: event.data.method, resourceType: event.data.resource_type };
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
  frames: {},
  apply: (event) =>
    set((s) => {
      if (event.type === "frame") {
        const key = `${event.data.tab_id}:${event.data.request_id}`;
        const next = [...(s.frames[key] ?? []), { direction: event.data.direction === "sent" ? "sent" : "received", payload: event.data.payload, at: event.data.timestamp ?? 0 } as FrameRow];
        return { frames: { ...s.frames, [key]: next.length > FRAME_CAP ? next.slice(next.length - FRAME_CAP) : next } };
      }
      const rows = fold(s.byTab[event.data.tab_id], event);
      if (event.type === "sent" || event.type === "socket") {
        const live = new Set(rows.map((row) => row.id));
        const prefix = `${event.data.tab_id}:`;
        const frames = Object.fromEntries(
          Object.entries(s.frames).filter(([key]) => !key.startsWith(prefix) || live.has(key.slice(prefix.length))),
        );
        return { byTab: { ...s.byTab, [event.data.tab_id]: rows }, frames };
      }
      return { byTab: { ...s.byTab, [event.data.tab_id]: rows } };
    }),
  clear: (tabId) => set((s) => ({ byTab: { ...s.byTab, [tabId]: [] }, frames: withoutTab(s.frames, tabId) })),
  drop: (tabId) =>
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab, frames: withoutTab(s.frames, tabId) };
    }),
}));

function withoutTab(frames: Record<string, FrameRow[]>, tabId: string): Record<string, FrameRow[]> {
  return Object.fromEntries(Object.entries(frames).filter(([k]) => !k.startsWith(`${tabId}:`)));
}

const NO_FRAMES: FrameRow[] = [];
export const selectFrames = (tabId: string | null, requestId: string | null) => (s: NetworkState) =>
  tabId && requestId ? (s.frames[`${tabId}:${requestId}`] ?? NO_FRAMES) : NO_FRAMES;

let listening: Promise<() => void> | null = null;

/** Subscribe once to network events from the engine. */
export function listenNetwork() {
  listening ??= events.networkEvent.listen((e) => useNetwork.getState().apply(e.payload));
  return listening;
}

const EMPTY: RequestRow[] = [];
export const selectRequests = (tabId: string | null) => (s: NetworkState) => (tabId ? (s.byTab[tabId] ?? EMPTY) : EMPTY);
