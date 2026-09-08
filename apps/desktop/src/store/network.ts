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
  /** Wall-clock seconds when the request left, to tell a reload's document from the last one. */
  sentAt: number;
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
  enqueue: (event: NetworkEvent) => void;
  flush: () => void;
  clear: (tabId: string) => void;
  drop: (tabId: string) => void;
  /** Keep requests across navigations, as DevTools' "Preserve log" does. Off, a reload shows only the new load. */
  preserve: boolean;
  setPreserve: (on: boolean) => void;
  /** The tab's main frame started loading `url`; the rows of the page it left go. */
  navigated: (tabId: string, url: string | null) => void;
}

/**
 * A load start whose document request has not been seen yet. The engine's
 * load start and the request's own event race through different channels,
 * so the trim waits for the document request when it has not arrived, for
 * a short while and for that address (a redirect changes the address, so the
 * time window alone stands in then).
 */
const awaitingDocument = new Map<string, { url: string | null; at: number }>();
const AWAIT_DOCUMENT_MS = 2000;
/** How recently a document request must have left to count as the page a load start announces. */
const RECENT_DOCUMENT_S = 3;

/** Whether a request starts the page a recent load start announced. */
export function beginsAwaitedPage(tabId: string, event: NetworkEvent, now = Date.now()): boolean {
  if (event.type !== "sent" || event.data.resource_type.toLowerCase() !== "document") return false;
  const awaited = awaitingDocument.get(tabId);
  if (!awaited) return false;
  return awaited.url === event.data.url || now - awaited.at < AWAIT_DOCUMENT_MS;
}

/** Tests only. */
export function resetNavigationWaits() {
  awaitingDocument.clear();
}

/**
 * The rows that belong to the page now loading: the newest document request
 * and everything after it. The engine reports a main-frame load start only
 * after the document request itself was sent, so that request is the first
 * row of the new page and the rows before it are the page that was left.
 */
export function rowsSinceNavigation(rows: readonly RequestRow[]): RequestRow[] {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.resourceType.toLowerCase() === "document") {
      start = i;
      break;
    }
  }
  return start <= 0 ? [...rows] : rows.slice(start);
}

/** Apply the same request semantics for immediate and batched updates. */
function updateRow(row: RequestRow | undefined, event: NetworkEvent): RequestRow | undefined {
  const at = event.data.timestamp ?? 0;
  if (event.type === "frame") return row;
  if (event.type === "sent" || event.type === "socket") {
    const base = { status: null, mimeType: "", fromCache: false, size: null, error: null, startedAt: row?.startedAt ?? at, durationMs: null, sentAt: row?.sentAt ?? (event.type === "sent" ? (event.data.wall_time ?? Date.now() / 1000) : Date.now() / 1000) };
    return event.type === "socket"
      ? { ...base, id: event.data.request_id, url: event.data.url, method: "GET", resourceType: "WebSocket", mimeType: "websocket" }
      : { ...base, id: event.data.request_id, url: event.data.url, method: event.data.method, resourceType: event.data.resource_type };
  }
  if (!row) return undefined;
  const durationMs = Math.max(0, Math.round((at - row.startedAt) * 1000));
  switch (event.type) {
    case "response": return { ...row, status: event.data.status, mimeType: event.data.mime_type, fromCache: event.data.from_cache };
    case "finished": return { ...row, size: event.data.encoded_length ?? 0, durationMs };
    // A blocked or failed request transferred nothing the person can use; an
    // engine-side error page must not read as 180 kB of response.
    case "failed": return { ...row, error: event.data.error, durationMs, size: null };
  }
}

/** Fold one lifecycle event into the row list. Pure for callers/tests. */
export function fold(rows: RequestRow[] | undefined, event: NetworkEvent): RequestRow[] {
  const list = rows ?? [];
  if (event.type === "frame") return list;
  const idx = list.findIndex((row) => row.id === event.data.request_id);
  const nextRow = updateRow(list[idx], event);
  if (!nextRow) return list;
  const next = idx === -1 ? [...list, nextRow] : list.map((row, i) => i === idx ? nextRow : row);
  return next.length > CAP ? next.slice(-CAP) : next;
}

/** Collapse traffic into bounded display state, never an unbounded raw event queue.
 * Backend rings/MCP/HAR still receive every event before frontend notification. */
class NetworkBatch {
  rows: Map<string, RequestRow>;
  frames: Map<string, FrameRow[]>;
  private copiedFrames = new Set<string>();
  constructor(rows: RequestRow[] | undefined, frames: Record<string, FrameRow[]>, tabId: string) {
    this.rows = new Map((rows ?? []).map((row) => [row.id, row]));
    const prefix = `${tabId}:`;
    this.frames = new Map(Object.entries(frames).filter(([key]) => key.startsWith(prefix) && this.rows.has(key.slice(prefix.length))).map(([key, values]) => [key.slice(prefix.length), values]));
  }
  apply(event: NetworkEvent): boolean {
    const id = event.data.request_id;
    if (event.type === "frame") {
      if (!this.rows.has(id)) return false;
      let frames = this.frames.get(id) ?? [];
      if (!this.copiedFrames.has(id)) { frames = [...frames]; this.frames.set(id, frames); this.copiedFrames.add(id); }
      frames.push({ direction: event.data.direction === "sent" ? "sent" : "received", payload: event.data.payload, at: event.data.timestamp ?? 0 });
      if (frames.length > FRAME_CAP) frames.shift();
      return true;
    }
    const row = updateRow(this.rows.get(id), event);
    if (!row) return false;
    this.rows.set(id, row);
    if (this.rows.size > CAP) {
      const oldest = this.rows.keys().next().value!;
      this.rows.delete(oldest);
      this.frames.delete(oldest);
      this.copiedFrames.delete(oldest);
    }
    return true;
  }
}

const pending = new Map<string, NetworkBatch>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function cancelPending(tabId: string) {
  pending.delete(tabId);
  if (!pending.size) { clearTimeout(flushTimer); flushTimer = undefined; }
}

export const useNetwork = create<NetworkState>((set, get) => ({
  byTab: {},
  frames: {},
  enqueue: (event) => {
    const tabId = event.data.tab_id;
    if (beginsAwaitedPage(tabId, event)) {
      awaitingDocument.delete(tabId);
      get().clear(tabId);
    }
    const batch = pending.get(tabId) ?? new NetworkBatch(get().byTab[tabId], get().frames, tabId);
    if (!batch.apply(event)) return;
    pending.set(tabId, batch);
    flushTimer ??= setTimeout(() => get().flush(), 33);
  },
  flush: () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!pending.size) return;
    const changes = new Map(pending);
    pending.clear();
    set((s) => {
      const byTab = { ...s.byTab };
      const frames = Object.fromEntries(Object.entries(s.frames).filter(([key]) => !Array.from(changes.keys()).some((tab) => key.startsWith(`${tab}:`))));
      for (const [tabId, batch] of changes) {
        byTab[tabId] = Array.from(batch.rows.values());
        for (const [requestId, values] of batch.frames) frames[`${tabId}:${requestId}`] = values;
      }
      return { byTab, frames };
    });
  },
  apply: (event) => {
    get().flush();
    if (beginsAwaitedPage(event.data.tab_id, event)) {
      awaitingDocument.delete(event.data.tab_id);
      get().clear(event.data.tab_id);
    }
    set((s) => {
      if (event.type === "frame") {
        if (!s.byTab[event.data.tab_id]?.some((row) => row.id === event.data.request_id)) return s;
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
    });
  },
  clear: (tabId) => {
    cancelPending(tabId);
    set((s) => ({ byTab: { ...s.byTab, [tabId]: [] }, frames: withoutTab(s.frames, tabId) }));
  },
  drop: (tabId) => {
    cancelPending(tabId);
    set((s) => {
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab, frames: withoutTab(s.frames, tabId) };
    });
  },
  preserve: false,
  setPreserve: (preserve) => set({ preserve }),
  navigated: (tabId, url) => {
    if (get().preserve) return;
    get().flush();
    const rows = get().byTab[tabId] ?? [];
    const kept = rowsSinceNavigation(rows);
    const newest = kept[0];
    // The document request already arrived when the newest one is this
    // page's: same address, and sent just now (a reload's previous document
    // has the same address but left long before the load start).
    const arrived = newest !== undefined && newest.resourceType.toLowerCase() === "document" && (url === null || newest.url === url) && Date.now() / 1000 - newest.sentAt < RECENT_DOCUMENT_S;
    if (arrived) {
      awaitingDocument.delete(tabId);
      if (kept.length === rows.length) return;
      set((s) => ({ byTab: { ...s.byTab, [tabId]: kept }, frames: keepFrames(s.frames, tabId, kept) }));
      return;
    }
    awaitingDocument.set(tabId, { url, at: Date.now() });
    if (rows.length > 0) get().clear(tabId);
  },
}));

function keepFrames(frames: Record<string, FrameRow[]>, tabId: string, kept: readonly RequestRow[]): Record<string, FrameRow[]> {
  const live = new Set(kept.map((row) => row.id));
  const prefix = `${tabId}:`;
  return Object.fromEntries(Object.entries(frames).filter(([key]) => !key.startsWith(prefix) || live.has(key.slice(prefix.length))));
}

function withoutTab(frames: Record<string, FrameRow[]>, tabId: string): Record<string, FrameRow[]> {
  return Object.fromEntries(Object.entries(frames).filter(([k]) => !k.startsWith(`${tabId}:`)));
}

const NO_FRAMES: FrameRow[] = [];
export const selectFrames = (tabId: string | null, requestId: string | null) => (s: NetworkState) =>
  tabId && requestId ? (s.frames[`${tabId}:${requestId}`] ?? NO_FRAMES) : NO_FRAMES;

let listening: Promise<() => void> | null = null;

/** Subscribe once to network events from the engine. */
export function listenNetwork() {
  listening ??= events.networkEvent.listen((e) => useNetwork.getState().enqueue(e.payload));
  return listening;
}

const EMPTY: RequestRow[] = [];
export const selectRequests = (tabId: string | null) => (s: NetworkState) => (tabId ? (s.byTab[tabId] ?? EMPTY) : EMPTY);
