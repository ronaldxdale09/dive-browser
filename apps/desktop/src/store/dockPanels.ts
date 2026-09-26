import { useCallback } from "react";
import { create } from "zustand";
import type { ColorFormats } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { onTabClosed } from "./browser";

/** The dock panels that read the page on request rather than as it changes. */
export type PanelRead = "a11y" | "stack" | "palette";

/** One panel's reading of one tab: what it found, on which page, and whether it is reading now. */
interface Slot {
  url: string;
  data: unknown;
  busy: boolean;
  error: string | null;
}

interface DockPanelsState {
  /** By `${panel}:${tabId}`. */
  slots: Record<string, Slot>;
  /** The colour last picked with the eyedropper, from anywhere on screen. */
  picked: ColorFormats | null;
  /** Colours picked lately, newest first. */
  recent: string[];
  setPicked: (picked: ColorFormats) => void;
}

/** How many picked colours are remembered. */
const RECENT_KEPT = 12;

/**
 * What the on-demand dock panels found, kept outside them.
 *
 * Each panel used to hold its findings in its own state, and the dock mounts
 * only the panel on show: switching to Network and back threw away an audit
 * that had taken a minute. Their busy and error flags were per panel too, not
 * per tab, so an audit running on one tab read "Running…" on every other and
 * one tab's failure was shown over the next tab's page. Findings belong to a
 * tab and to the page they were taken on; they go when the tab does.
 */
export const useDockPanels = create<DockPanelsState>((set) => ({
  slots: {},
  picked: null,
  recent: [],
  setPicked: (picked) => set((s) => ({ picked, recent: [picked.hex, ...s.recent.filter((h) => h !== picked.hex)].slice(0, RECENT_KEPT) })),
}));

onTabClosed((tabId) => {
  useDockPanels.setState((s) => {
    const gone = Object.keys(s.slots).filter((key) => key.endsWith(`:${tabId}`));
    if (gone.length === 0) return s;
    const slots = { ...s.slots };
    for (const key of gone) delete slots[key];
    return { slots };
  });
});

/**
 * One panel's reading of the active tab: the findings for the page it is on
 * now (nothing for a page it has not read), whether a read is running on this
 * tab, and a way to start one.
 */
export function usePanelRead<T>(panel: PanelRead, tabId: string | null, url: string) {
  const key = tabId ? `${panel}:${tabId}` : null;
  const slot = useDockPanels((s) => (key ? s.slots[key] : undefined));
  const fresh = slot !== undefined && slot.url === url;
  const run = useCallback(
    async (read: (tabId: string) => Promise<T>) => {
      if (!key || !tabId) return;
      // The page the read was asked of. The tab can navigate while it runs;
      // the findings stay with the page they describe.
      const at = url;
      const put = (next: Partial<Slot>) =>
        useDockPanels.setState((s) => {
          const old = s.slots[key];
          const base: Slot = old && old.url === at ? old : { url: at, data: null, busy: false, error: null };
          return { slots: { ...s.slots, [key]: { ...base, ...next, url: at } } };
        });
      put({ busy: true, error: null });
      try {
        put({ data: await read(tabId), busy: false });
      } catch (e) {
        put({ busy: false, error: errorMessage(e) });
      }
    },
    [key, tabId, url],
  );
  return {
    data: fresh ? (slot.data as T | null) : null,
    // Running on this tab, whichever page it started on: a second read on
    // top of it would race the first.
    busy: slot?.busy ?? false,
    error: fresh ? slot.error : null,
    run,
  };
}
