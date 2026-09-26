import { useCallback, useEffect, useState } from "react";
import { events, ipc } from "./ipc";
import type { NavigationHistory } from "./ipc";

type Availability = { tabId: string; canBack: boolean; canForward: boolean };

const availability = (tabId: string, history: NavigationHistory): Availability => ({
  tabId,
  canBack: history.current_index > 0,
  canForward: history.current_index >= 0 && history.current_index < history.entries.length - 1,
});

/**
 * Whether the tab can go back or forward, as the engine has it, and a way to
 * read its whole back/forward stack when a history menu opens. Never
 * reconstructed from visited URLs.
 *
 * The engine announces every move with the two answers the buttons need, so
 * the stack itself is read once when the tab is first shown and otherwise
 * only on demand. Reading it on every loading and address change as well as
 * on each announcement was three to five reads per navigation.
 */
export function useTabHistory(tabId: string | null, url: string) {
  const [state, setState] = useState<Availability | null>(null);
  useEffect(() => {
    if (!tabId) return;
    let alive = true;
    // An announcement is newer than whatever the first read returns.
    let heard = false;
    let unlisten: (() => void) | undefined;
    const readOnce = () => {
      ipc.tabHistory(tabId).then(
        (history) => { if (alive && !heard) setState(availability(tabId, history)); },
        // Closed or replaced views have no actionable history.
        () => { if (alive && !heard) setState(null); },
      );
    };
    // Subscribe first, then read: a navigation during setup cannot leave the
    // first answer stale.
    void events.tabHistoryChanged.listen(({ payload }) => {
      if (!alive || payload.tab_id !== tabId) return;
      heard = true;
      setState((current) =>
        current?.tabId === tabId && current.canBack === payload.can_go_back && current.canForward === payload.can_go_forward
          ? current
          : { tabId, canBack: payload.can_go_back, canForward: payload.can_go_forward });
    }).then((off) => {
      if (!alive) { off(); return; }
      unlisten = off;
      readOnce();
    }).catch(readOnce);
    return () => { alive = false; unlisten?.(); };
  }, [tabId]);
  const internal = url.startsWith("dive://");
  const current = state?.tabId === tabId && !internal ? state : null;
  const loadHistory = useCallback(async (): Promise<NavigationHistory | null> => {
    if (!tabId || internal) return null;
    try { return await ipc.tabHistory(tabId); } catch { return null; }
  }, [tabId, internal]);
  return {
    canBack: current?.canBack ?? false,
    canForward: current?.canForward ?? false,
    loadHistory,
  };
}
