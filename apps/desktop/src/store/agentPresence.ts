import { create } from "zustand";
import { events } from "../generated/bindings";

/**
 * Which tabs an agent is driving right now.
 *
 * The host decides this -- every action an agent takes on a page goes through
 * one place there, and it already lingers past the last one so a burst of
 * clicks reads as one continuous state. The chrome only has to remember what
 * it was told, so a tab list rendered before the first event is simply not
 * driven rather than briefly wrong.
 */
interface AgentPresenceState {
  /** Tab ids currently being driven. */
  driving: Readonly<Record<string, true>>;
  /** Note that `tab` started or stopped being driven. */
  set: (tab: string, driving: boolean) => void;
  /** Forget everything, for tests. */
  reset: () => void;
}

export const useAgentPresence = create<AgentPresenceState>((set) => ({
  driving: {},
  set: (tab, driving) =>
    set((state) => {
      if (Boolean(state.driving[tab]) === driving) return state;
      const next = { ...state.driving };
      if (driving) next[tab] = true;
      else delete next[tab];
      return { driving: next };
    }),
  reset: () => set({ driving: {} }),
}));

/** Whether an agent is working in `tab`. */
export function useIsDriven(tabId: string | null | undefined): boolean {
  return useAgentPresence((s) => (tabId ? Boolean(s.driving[tabId]) : false));
}

let listening = false;

/** Wire the host's presence events once. */
export function listenForAgentPresence() {
  if (listening) return;
  listening = true;
  // Outside Tauri (tests) there is no event bridge; nothing is driven, which
  // is the right answer there.
  void events.agentPresence
    .listen((e) => useAgentPresence.getState().set(e.payload.tab_id, e.payload.driving))
    .catch(() => undefined);
}
