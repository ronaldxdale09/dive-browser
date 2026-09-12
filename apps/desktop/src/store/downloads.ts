import { create } from "zustand";
import type { DownloadNotice, DownloadProgress } from "../lib/ipc";
import { fileNameOr } from "../lib/paths";

export type DownloadStatus = "started" | "finished" | "failed";

export interface Download {
  url: string;
  path: string;
  /** File name, or the URL when the engine gave no path. */
  name: string;
  status: DownloadStatus;
  /** Wall-clock ms of the last change. */
  at: number;
  /** When it began, for the elapsed time a row shows. */
  startedAt: number;
  /** The engine's id for it, once progress has arrived. Cancelling needs it. */
  id?: number;
  /** Bytes written so far, while it is going. */
  received?: number;
  /** Total size, when the server declared one. */
  total?: number;
  /** Bytes per second. */
  speed?: number;
  /** Whether it is paused. */
  paused?: boolean;
}

interface DownloadsState {
  /** Newest first, fed by the browser store's download listener. This session only; the files are the record. */
  items: Download[];
  apply: (notice: DownloadNotice) => void;
  progress: (update: DownloadProgress) => void;
  clear: () => void;
}

const CAP = 50;

/** Fold a notice into the list: a start adds a row, its finish or failure updates it. Pure for tests. */
export function fold(items: Download[], notice: DownloadNotice, at = Date.now()): Download[] {
  const status: DownloadStatus = notice.status === "started" || notice.status === "finished" ? notice.status : "failed";
  // With a path, match the file whatever state its row is in: a second
  // `finished` for the same download -- which the engine emits on every update
  // once it is complete -- otherwise fell through and added a duplicate row
  // and a duplicate toast.
  //
  // Without one, the notice is a failure that never got a destination, and it
  // belongs to whichever row is still running for that URL. Two such failures
  // stay two rows, because only the first finds something in flight.
  const same = (d: Download) =>
    notice.path ? d.path === notice.path : d.url === notice.url && d.status === "started";
  const idx = items.findIndex(same);
  if (idx !== -1) {
    return items.map((d, i) =>
      i === idx
        ? {
            ...d,
            status,
            at,
            path: notice.path || d.path,
            // A finished download is whole by definition, whatever the last
            // progress report happened to say.
            ...(status === "finished" && d.total ? { received: d.total } : {}),
            ...(status === "started" ? {} : { speed: 0, paused: false }),
          }
        : d,
    );
  }
  const name = fileNameOr(notice.path, notice.url);
  return [{ url: notice.url, path: notice.path, name, status, at, startedAt: at }, ...items].slice(0, CAP);
}

/**
 * Fold a progress report into the list. Pure for tests.
 *
 * Matched by path where there is one and by URL until then: the engine decides
 * the destination first and reports it with the start, but the first progress
 * can arrive before the chrome has processed that.
 */
export function foldProgress(items: Download[], update: DownloadProgress, at = Date.now()): Download[] {
  const idx = items.findIndex((d) =>
    update.path ? d.path === update.path : d.url === update.url,
  );
  // A report for a download the chrome never heard start is still worth a row:
  // better a live row that appeared late than none at all.
  if (idx === -1) {
    const name = fileNameOr(update.path, update.url);
    return [
      {
        url: update.url, path: update.path, name, status: "started" as const, at, startedAt: at,
        id: update.id, received: update.received ?? 0, speed: update.speed ?? 0, paused: update.paused,
        ...(update.total === null ? {} : { total: update.total }),
      },
      ...items,
    ].slice(0, CAP);
  }
  return items.map((d, i) =>
    i === idx
      ? {
          ...d,
          // `at` is deliberately not touched: it marks the last change of
          // state, and a row that ticks it every quarter second would reset
          // its own "just now" forever and re-key itself out of the DOM.
          id: update.id,
          path: d.path || update.path,
          name: d.path || update.path ? fileNameOr(d.path || update.path, d.name) : d.name,
          received: update.received ?? d.received ?? 0,
          speed: update.speed ?? 0,
          paused: update.paused,
          ...(update.total === null ? {} : { total: update.total }),
        }
      : d,
  );
}

export const useDownloads = create<DownloadsState>((set) => ({
  items: [],
  apply: (notice) => set((s) => ({ items: fold(s.items, notice) })),
  progress: (update) => set((s) => ({ items: foldProgress(s.items, update) })),
  clear: () => set({ items: [] }),
}));

/** Downloads still in flight. */
export const selectActive = (s: DownloadsState) => s.items.filter((d) => d.status === "started").length;
