import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { ExternalLinkAsked } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * A page asked to open a link another app handles. One question at a time --
 * a page that fires several only gets asked about the newest -- and the URL
 * itself stays in the host: the card answers with the token it was given.
 */
interface ExternalLinkStore {
  asked: ExternalLinkAsked | null;
  listening: boolean;
  init: () => Promise<void>;
  /** Hand the link to the system, remembering the site when `always`. */
  open: (asked: ExternalLinkAsked, always: boolean) => Promise<void>;
  /** Let the link go. */
  cancel: (asked: ExternalLinkAsked) => void;
}

export const useExternalLink = create<ExternalLinkStore>((set, get) => ({
  asked: null,
  listening: false,
  init: async () => {
    if (get().listening) return;
    set({ listening: true });
    try {
      await events.externalLinkAsked.listen((e) => {
        // The one it replaces is no longer being asked about, so it must not
        // be left waiting in the host.
        const previous = get().asked;
        if (previous && previous.token !== e.payload.token) void ipc.externalLinkDismiss(previous.token);
        set({ asked: e.payload });
      });
    } catch {
      // No host (a test, or a chrome without Tauri): nothing to listen to.
      set({ listening: false });
    }
  },
  open: async (asked, always) => {
    set({ asked: null });
    try {
      await ipc.externalLinkOpen(asked.token, always);
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  cancel: (asked) => {
    set({ asked: null });
    void ipc.externalLinkDismiss(asked.token).catch(() => undefined);
  },
}));
