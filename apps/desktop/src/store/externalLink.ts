import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { ExternalLinkAsked } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * Pages asking to open a link another app handles. One question per tab --
 * the host replaces a tab's older question with its newest -- and the URL
 * itself stays in the host: the card answers with the token it was given.
 *
 * Every window hears every question and shows only its own tabs' ones, so
 * a torn-off tab or an app window asks in its own window rather than behind
 * it in the main one. The host's `closed` notice takes an answered question
 * out of every window, not only the one that answered it.
 */
interface ExternalLinkStore {
  /** Open questions, oldest first; at most one per tab. */
  questions: ExternalLinkAsked[];
  listening: boolean;
  init: () => Promise<void>;
  /** Hand the link to the system, remembering the site when `always`. */
  open: (asked: ExternalLinkAsked, always: boolean) => Promise<void>;
  /** Let the link go. */
  cancel: (asked: ExternalLinkAsked) => void;
}

function without(questions: ExternalLinkAsked[], token: string) {
  return questions.filter((q) => q.token !== token);
}

/** The newest question from a tab this window shows, if any. */
export function questionFor(questions: ExternalLinkAsked[], shows: (tabId: string) => boolean): ExternalLinkAsked | null {
  return questions.findLast((q) => shows(q.tab_id)) ?? null;
}

export const useExternalLink = create<ExternalLinkStore>((set, get) => ({
  questions: [],
  listening: false,
  init: async () => {
    if (get().listening) return;
    set({ listening: true });
    try {
      await events.externalLinkAsked.listen((e) => {
        const asked = e.payload;
        set((s) => ({ questions: [...s.questions.filter((q) => q.tab_id !== asked.tab_id && q.token !== asked.token), asked] }));
      });
      await events.externalLinkClosed.listen((e) => set((s) => ({ questions: without(s.questions, e.payload.token) })));
    } catch {
      // No host (a test, or a chrome without Tauri): nothing to listen to.
      set({ listening: false });
    }
  },
  open: async (asked, always) => {
    set((s) => ({ questions: without(s.questions, asked.token) }));
    try {
      await ipc.externalLinkOpen(asked.token, always);
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  cancel: (asked) => {
    set((s) => ({ questions: without(s.questions, asked.token) }));
    void ipc.externalLinkDismiss(asked.token).catch(() => undefined);
  },
}));
