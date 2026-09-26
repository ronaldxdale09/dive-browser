import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { JsDialogAsked } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { pageAnsweredClose, pagePromptedOnClose, useBrowser } from "./browser";

/**
 * JavaScript dialogs pages have open (`alert`, `confirm`, `prompt` and the
 * leave-page question), one queue per tab. The page's script waits until
 * the first one is answered; the card shows the oldest.
 */
interface JsDialogStore {
  byTab: Record<string, JsDialogAsked[]>;
  listening: boolean;
  init: () => Promise<void>;
  recover: (tabId: string) => Promise<void>;
  /** OK, or Cancel; `text` is what a prompt receives. */
  answer: (dialog: JsDialogAsked, accept: boolean, text?: string) => Promise<void>;
}

function without(list: JsDialogAsked[] | undefined, dialogId: string) {
  return (list ?? []).filter((d) => d.dialog_id !== dialogId);
}

export const useJsDialog = create<JsDialogStore>((set, get) => {
  let starting: Promise<void> | undefined;
  // Only retain changes while a snapshot is in flight; closed IDs do not
  // accumulate for the lifetime of the browser.
  const snapshots = new Set<{ tabId: string; changed: Set<string> }>();
  const changed = (tabId: string, dialogId: string) => {
    for (const snapshot of snapshots) if (snapshot.tabId === tabId) snapshot.changed.add(dialogId);
  };
  return {
    byTab: {},
    listening: false,
    init: async () => {
      if (starting) return starting;
      if (get().listening) return;
      starting = (async () => {
        const stops: (() => void)[] = [];
        try {
          stops.push(await events.jsDialogClosed.listen((e) => {
            const { tab_id, dialog_id } = e.payload;
            changed(tab_id, dialog_id);
            pageAnsweredClose(tab_id);
            set((s) => {
              const rest = without(s.byTab[tab_id], dialog_id);
              const byTab = { ...s.byTab };
              if (rest.length) byTab[tab_id] = rest;
              else delete byTab[tab_id];
              return { byTab };
            });
          }));
          stops.push(await events.jsDialogAsked.listen((e) => {
            const d = e.payload;
            changed(d.tab_id, d.dialog_id);
            if (d.kind === "beforeunload") pagePromptedOnClose(d.tab_id);
            set((s) => {
              const current = s.byTab[d.tab_id] ?? [];
              // Recovery may deliver this ID before its asked event. Update
              // in place so delayed/repeated events cannot reorder the queue.
              const list = current.some((open) => open.dialog_id === d.dialog_id)
                ? current.map((open) => open.dialog_id === d.dialog_id ? d : open)
                : [...current, d];
              return { byTab: { ...s.byTab, [d.tab_id]: list } };
            });
          }));
          set({ listening: true });
        } catch {
          stops.forEach((stop) => stop());
          set({ listening: false });
        }
      })();
      try { await starting; } finally { starting = undefined; }
    },
    recover: async (tabId) => {
      await get().init();
      if (!get().listening) return;
      const snapshot = { tabId, changed: new Set<string>() };
      snapshots.add(snapshot);
      try {
        const pending = await ipc.jsDialogPending(tabId);
        set((s) => {
          // Keep native queue order, but let events/answers win for their
          // IDs, including closes for dialogs this chrome never saw.
          const current = s.byTab[tabId] ?? [];
          const owned = pending.filter((d) => d.tab_id === tabId);
          const ids = new Set(owned.map((d) => d.dialog_id));
          const list = [
            ...owned.flatMap((d) => snapshot.changed.has(d.dialog_id)
              ? current.filter((live) => live.dialog_id === d.dialog_id) : [d]),
            ...current.filter((d) => snapshot.changed.has(d.dialog_id) && !ids.has(d.dialog_id)),
          ];
          const byTab = { ...s.byTab };
          if (list.length) byTab[tabId] = list;
          else delete byTab[tabId];
          return { byTab };
        });
      } catch {
        // Closing/reparenting chrome can outlive its host. Live events continue
        // to work; a later mount can retry recovery.
      } finally {
        snapshots.delete(snapshot);
      }
    },
    answer: async (dialog, accept, text) => {
      changed(dialog.tab_id, dialog.dialog_id);
      pageAnsweredClose(dialog.tab_id);
      set((s) => {
        const rest = without(s.byTab[dialog.tab_id], dialog.dialog_id);
        const byTab = { ...s.byTab };
        if (rest.length) byTab[dialog.tab_id] = rest;
        else delete byTab[dialog.tab_id];
        return { byTab };
      });
      try {
        await ipc.jsDialogAnswer(dialog.tab_id, dialog.dialog_id, accept, accept && dialog.kind === "prompt" ? (text ?? dialog.default_value) : null);
      } catch (e) {
        // Already answered (an agent got there first) or the page moved on:
        // nothing to show for that. Anything else is worth a line.
        if (!/no longer open/i.test(errorMessage(e))) useBrowser.setState({ error: errorMessage(e) });
      }
    },
  };
});
