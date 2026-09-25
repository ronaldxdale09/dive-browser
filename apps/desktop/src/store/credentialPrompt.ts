import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { CredentialPrompt } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * The host's questions about logins: save this one, update it, or forget
 * one whose password the OS store has lost. One per tab, newest wins; the
 * password itself never reaches the chrome, only a token to answer with.
 */
interface CredentialPromptStore {
  byTab: Record<string, CredentialPrompt>;
  listening: boolean;
  init: () => Promise<void>;
  /** Save or let go of the submitted login. */
  answer: (prompt: CredentialPrompt, save: boolean) => Promise<void>;
  /** Let the login go and stop asking for this site in this profile. */
  never: (prompt: CredentialPrompt) => Promise<void>;
  /** Forget a login whose password the OS store no longer has. */
  forget: (prompt: CredentialPrompt) => Promise<void>;
  dismiss: (tabId: string) => void;
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const useCredentialPrompt = create<CredentialPromptStore>((set, get) => ({
  byTab: {},
  listening: false,
  init: async () => {
    if (get().listening) return;
    set({ listening: true });
    try {
      await events.credentialPrompt.listen((e) => {
        set((s) => ({ byTab: { ...s.byTab, [e.payload.tab_id]: e.payload } }));
      });
      // A prompt outlives nothing it was about. A closed tab lets its
      // password go at once, instead of the host holding it until quit; a
      // "missing" card for a site the tab has since left no longer applies.
      useBrowser.subscribe((state, previous) => {
        if (state.tabs === previous.tabs) return;
        const byId = new Map(state.tabs.map((t) => [t.id, t]));
        for (const prompt of Object.values(get().byTab)) {
          const tab = byId.get(prompt.tab_id);
          if (!tab) {
            if (prompt.kind === "missing") get().dismiss(prompt.tab_id);
            else void get().answer(prompt, false);
          } else if (prompt.kind === "missing" && originOf(tab.url) !== prompt.origin) {
            get().dismiss(prompt.tab_id);
          }
        }
      });
    } catch {
      // No host (a test, or a chrome without Tauri): nothing to listen to.
      set({ listening: false });
    }
  },
  answer: async (prompt, save) => {
    get().dismiss(prompt.tab_id);
    try {
      const saved = await ipc.passwordsAnswer(prompt.token, save);
      if (!save) return;
      const site = prompt.origin.replace(/^https?:\/\//, "");
      if (saved) useBrowser.getState().notify(prompt.kind === "update" ? `Updated the password for ${site}` : `Saved the login for ${site}`, 3000);
    } catch (e) {
      // Letting a login go has nothing to report: a prompt a newer sign-in
      // already replaced is gone either way.
      if (save) useBrowser.setState({ error: errorMessage(e) });
    }
  },
  never: async (prompt) => {
    get().dismiss(prompt.tab_id);
    try {
      const origin = await ipc.passwordsNever(prompt.token);
      useBrowser.getState().notify(`Won't offer to save passwords for ${origin.replace(/^https?:\/\//, "")}. Change it under Settings › Passwords & forms.`, 4000);
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  forget: async (prompt) => {
    get().dismiss(prompt.tab_id);
    try {
      await ipc.passwordsDelete(prompt.token);
      const site = prompt.origin.replace(/^https?:\/\//, "");
      useBrowser.getState().notify(`Forgot the login for ${prompt.username} on ${site}. Sign in again to save it.`, 4000);
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  dismiss: (tabId) =>
    set((s) => {
      const rest = { ...s.byTab };
      delete rest[tabId];
      return { byTab: rest };
    }),
}));
