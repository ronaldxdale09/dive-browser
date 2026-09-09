import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { JsDialogAsked } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * JavaScript dialogs pages have open (`alert`, `confirm`, `prompt` and the
 * leave-page question), one queue per tab. The page's script waits until
 * the first one is answered; the card shows the oldest.
 */
interface JsDialogStore {
  byTab: Record<string, JsDialogAsked[]>;
  listening: boolean;
  init: () => Promise<void>;
  /** OK, or Cancel; `text` is what a prompt receives. */
  answer: (dialog: JsDialogAsked, accept: boolean, text?: string) => Promise<void>;
}

function without(list: JsDialogAsked[] | undefined, dialogId: string) {
  return (list ?? []).filter((d) => d.dialog_id !== dialogId);
}

export const useJsDialog = create<JsDialogStore>((set, get) => ({
  byTab: {},
  listening: false,
  init: async () => {
    if (get().listening) return;
    set({ listening: true });
    try {
      await events.jsDialogAsked.listen((e) => {
        const d = e.payload;
        set((s) => ({ byTab: { ...s.byTab, [d.tab_id]: [...without(s.byTab[d.tab_id], d.dialog_id), d] } }));
      });
      await events.jsDialogClosed.listen((e) => {
        const { tab_id, dialog_id } = e.payload;
        set((s) => {
          const rest = without(s.byTab[tab_id], dialog_id);
          const byTab = { ...s.byTab };
          if (rest.length) byTab[tab_id] = rest;
          else delete byTab[tab_id];
          return { byTab };
        });
      });
    } catch {
      // No host (a test, or a chrome without Tauri): nothing to listen to.
      set({ listening: false });
    }
  },
  answer: async (dialog, accept, text) => {
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
}));
