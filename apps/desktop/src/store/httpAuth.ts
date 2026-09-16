import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { HttpAuthAsked } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * Servers and proxies waiting to be told who you are, one queue per tab.
 *
 * The request is held open inside the engine while the card is up, so a tab
 * with a challenge is a tab that is genuinely waiting — answering it or
 * cancelling it is what lets the page finish either way.
 */
interface HttpAuthStore {
  byTab: Record<string, HttpAuthAsked[]>;
  listening: boolean;
  init: () => Promise<void>;
  recover: (tabId: string) => Promise<void>;
  /** A username signs in; `null` cancels and the page sees the refusal. */
  answer: (asked: HttpAuthAsked, username: string | null, password: string) => Promise<void>;
}

function without(list: HttpAuthAsked[] | undefined, requestId: string) {
  return (list ?? []).filter((a) => a.request_id !== requestId);
}

export const useHttpAuth = create<HttpAuthStore>((set, get) => {
  let starting: Promise<void> | undefined;
  const drop = (tabId: string, requestId: string) =>
    set((s) => {
      const rest = without(s.byTab[tabId], requestId);
      const byTab = { ...s.byTab };
      if (rest.length) byTab[tabId] = rest;
      else delete byTab[tabId];
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
          stops.push(
            await events.httpAuthClosed.listen((e) => drop(e.payload.tab_id, e.payload.request_id)),
          );
          stops.push(
            await events.httpAuthAsked.listen((e) => {
              const asked = e.payload;
              set((s) => {
                const current = s.byTab[asked.tab_id] ?? [];
                const list = current.some((open) => open.request_id === asked.request_id)
                  ? current.map((open) => (open.request_id === asked.request_id ? asked : open))
                  : [...current, asked];
                return { byTab: { ...s.byTab, [asked.tab_id]: list } };
              });
            }),
          );
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
        const pending = await ipc.httpAuthPending(tabId);
        set((s) => {
          const byTab = { ...s.byTab };
          if (pending.length) byTab[tabId] = pending;
          else delete byTab[tabId];
          return { byTab };
        });
      } catch {
        // A chrome that is closing can outlive its host; live events still
        // work and a later mount can try again.
      }
    },
    answer: async (asked, username, password) => {
      drop(asked.tab_id, asked.request_id);
      try {
        await ipc.httpAuthAnswer(asked.tab_id, asked.request_id, username, username === null ? null : password);
      } catch (e) {
        if (!/no longer waiting/i.test(errorMessage(e))) {
          useBrowser.setState({ error: errorMessage(e) });
        }
      }
    },
  };
});
