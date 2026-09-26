import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { CertErrorAsked } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * Pages stopped on a certificate the network would not accept, one question
 * per tab. The request is held open inside the engine while the question is
 * up; going back refuses it, proceeding lets it through.
 */
interface CertErrorStore {
  byTab: Record<string, CertErrorAsked>;
  listening: boolean;
  init: () => Promise<void>;
  /** Pick up a question a reloaded chrome missed. */
  recover: (tabId: string) => Promise<void>;
  answer: (asked: CertErrorAsked, proceed: boolean) => Promise<void>;
}

export const useCertError = create<CertErrorStore>((set, get) => {
  let starting: Promise<void> | undefined;
  const drop = (tabId: string, requestId: string) =>
    set((s) => {
      if (s.byTab[tabId]?.request_id !== requestId) return s;
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    });
  return {
    byTab: {},
    listening: false,
    init: async () => {
      if (starting) return starting;
      if (get().listening) return;
      starting = (async () => {
        const stops: (() => void)[] = [];
        try {
          stops.push(await events.certErrorClosed.listen((e) => drop(e.payload.tab_id, e.payload.request_id)));
          stops.push(await events.certErrorAsked.listen((e) => set((s) => ({ byTab: { ...s.byTab, [e.payload.tab_id]: e.payload } }))));
          set({ listening: true });
        } catch {
          stops.forEach((stop) => stop());
          set({ listening: false });
        }
      })();
      try {
        await starting;
      } finally {
        starting = undefined;
      }
    },
    recover: async (tabId) => {
      await get().init();
      if (!get().listening) return;
      try {
        const pending = await ipc.certErrorPending(tabId);
        set((s) => {
          const byTab = { ...s.byTab };
          if (pending) byTab[tabId] = pending;
          else delete byTab[tabId];
          return { byTab };
        });
      } catch {
        // Live events still arrive; a later mount can ask again.
      }
    },
    answer: async (asked, proceed) => {
      drop(asked.tab_id, asked.request_id);
      try {
        await ipc.certErrorAnswer(asked.tab_id, asked.request_id, proceed);
      } catch (e) {
        useBrowser.setState({ error: errorMessage(e) });
      }
    },
  };
});
