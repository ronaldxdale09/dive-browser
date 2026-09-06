import { useEffect, useState } from "react";
import { events, ipc } from "./ipc";
import type { NavigationHistory } from "./ipc";

/** The engine's back/forward stack, never reconstructed from visited URLs. */
export function useTabHistory(tabId: string | null, url: string, loading: boolean) {
  const [snapshot, setSnapshot] = useState<{ tabId: string; url: string; loading: boolean; history: NavigationHistory | null } | null>(null);
  useEffect(() => {
    if (!tabId || url.startsWith("dive://")) return;
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
        if (alive && !dirty) setSnapshot({ tabId, url, loading, history });
      } while (alive && dirty);
      pending = false;
    };
    // Subscribe first, then read: a navigation during setup cannot leave the
    // first snapshot stale. Bursts coalesce into one follow-up while querying.
    void events.tabHistoryChanged.listen(({ payload }) => {
      if (payload.tab_id === tabId) void refresh();
    }).then((off) => {
      if (!alive) { off(); return; }
      unlisten = off;
      void refresh();
    }).catch(() => { void refresh(); });
    return () => { alive = false; unlisten?.(); };
  }, [tabId, url, loading]);
  const history = snapshot?.tabId === tabId && snapshot.url === url && snapshot.loading === loading && !url.startsWith("dive://") ? snapshot.history : null;
  return {
    history,
    canBack: history !== null && history.current_index > 0,
    canForward: history !== null && history.current_index >= 0 && history.current_index < history.entries.length - 1,
  };
}
