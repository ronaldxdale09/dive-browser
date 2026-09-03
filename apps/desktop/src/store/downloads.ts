import { create } from "zustand";
import type { DownloadNotice } from "../lib/ipc";

export type DownloadStatus = "started" | "finished" | "failed";

export interface Download {
  url: string;
  path: string;
  /** File name, or the URL when the engine gave no path. */
  name: string;
  status: DownloadStatus;
  /** Wall-clock ms of the last change. */
  at: number;
}

interface DownloadsState {
  /** Newest first, fed by the browser store's download listener. This session only; the files are the record. */
  items: Download[];
  apply: (notice: DownloadNotice) => void;
  clear: () => void;
}

const CAP = 50;

/** Fold a notice into the list: a start adds a row, its finish or failure updates it. Pure for tests. */
export function fold(items: Download[], notice: DownloadNotice, at = Date.now()): Download[] {
  const status: DownloadStatus = notice.status === "started" || notice.status === "finished" ? notice.status : "failed";
  const same = (d: Download) => d.status === "started" && (notice.path ? d.path === notice.path : d.url === notice.url);
  const idx = items.findIndex(same);
  if (idx !== -1) return items.map((d, i) => (i === idx ? { ...d, status, at, path: notice.path || d.path } : d));
  const name = notice.path.split("/").pop() || notice.url;
  return [{ url: notice.url, path: notice.path, name, status, at }, ...items].slice(0, CAP);
}

export const useDownloads = create<DownloadsState>((set) => ({
  items: [],
  apply: (notice) => set((s) => ({ items: fold(s.items, notice) })),
  clear: () => set({ items: [] }),
}));

/** Downloads still in flight. */
export const selectActive = (s: DownloadsState) => s.items.filter((d) => d.status === "started").length;
