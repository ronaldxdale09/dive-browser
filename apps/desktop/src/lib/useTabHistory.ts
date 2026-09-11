import { useEffect, useRef, useState } from "react";
import { events, ipc } from "./ipc";
import type { NavigationHistory } from "./ipc";

/** The engine's back/forward stack, never reconstructed from visited URLs. */
export function useTabHistory(tabId: string | null, url: string, loading: boolean) {
  const [snapshot, setSnapshot] = useState<{ tabId: string; url: string; loading: boolean; history: NavigationHistory | null } | null>(null);
  // What the snapshot should report, without re-subscribing when it changes.
  const latest = useRef({ url, loading });
  // A navigation the engine does not announce (an SPA pushState) still moves
  // the stack, so a url change asks for a fresh read -- a single IPC, not a
  // teardown and rebuild of the subscription.
  const refetch = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = { url, loading };
    refetch.current?.();
  }, [url, loading]);
  useEffect(() => {
    if (!tabId || latest.current.url.startsWith("dive://")) return;
    let alive = true;
    let pending = false;
    let dirty = false;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      if (!alive) return;
      if (pending) { dirty = true; return; }
      pending = true;
      do {
        dirty = false;
        let history: NavigationHistory | null = null;
        try { history = await ipc.tabHistory(tabId); } catch { /* Closed or replaced views have no actionable history. */ }
        if (alive && !dirty) setSnapshot({ tabId, url: latest.current.url, loading: latest.current.loading, history });
      } while (alive && dirty);
      pending = false;
    };
    refetch.current = () => void refresh();
    // Subscribe first, then read: a navigation during setup cannot leave the
    // first snapshot stale. Bursts coalesce into one follow-up while querying.
    void events.tabHistoryChanged.listen(({ payload }) => {
      if (payload.tab_id === tabId) void refresh();
    }).then((off) => {
      if (!alive) { off(); return; }
      unlisten = off;
      void refresh();
    }).catch(() => { void refresh(); });
    return () => { alive = false; refetch.current = null; unlisten?.(); };
    // Keyed on the tab alone. `url` and `loading` are read through refs
    // below: including them tore the listener down and rebuilt it three times
    // per navigation, and once more for every SPA pushState.
  }, [tabId]);
  const history = snapshot?.tabId === tabId && snapshot.url === url && !url.startsWith("dive://") ? snapshot.history : null;
  return {
    history,
    canBack: history !== null && history.current_index > 0,
    canForward: history !== null && history.current_index >= 0 && history.current_index < history.entries.length - 1,
  };
}
