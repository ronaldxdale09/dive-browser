import { create } from "zustand";
import { events, ipc } from "../lib/ipc";
import type { CredentialPrompt } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * The host's questions about logins: save this one, update it, or pick
 * which to fill. One per tab, newest wins; the password itself never
 * reaches the chrome, only a token to answer with.
 */
interface CredentialPromptStore {
  byTab: Record<string, CredentialPrompt>;
  listening: boolean;
  init: () => Promise<void>;
  /** Save or let go of the submitted login. */
  answer: (prompt: CredentialPrompt, save: boolean) => Promise<void>;
  /** Fill the login with `username` into the prompt's tab. */
  pick: (prompt: CredentialPrompt, username: string) => Promise<void>;
  dismiss: (tabId: string) => void;
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
    } catch {
      // No host (a test, or a chrome without Tauri): nothing to listen to.
      set({ listening: false });
    }
  },
  answer: async (prompt, save) => {
    get().dismiss(prompt.tab_id);
    try {
      const saved = await ipc.passwordsAnswer(prompt.token, save);
      if (saved) useBrowser.getState().notify(`Saved the login for ${prompt.origin.replace(/^https?:\/\//, "")}`, 3000);
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
    }
  },
  pick: async (prompt, username) => {
    get().dismiss(prompt.tab_id);
    try {
      const logins = await ipc.passwordsForUrl(prompt.origin);
      const login = logins.find((c) => c.username === username);
      if (!login) throw new Error(`No saved login for ${username}`);
      await ipc.passwordsFill(prompt.tab_id, login.id);
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
