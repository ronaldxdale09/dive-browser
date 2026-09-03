import { useEffect, useState } from "react";

/**
 * Fetch something about the active tab whenever the tab or its URL changes,
 * with a manual refresh and stale-response protection. Shared by the dock
 * panels that read page state on demand.
 */
export function useTabData<T>(tabId: string | null, url: string | undefined, fetcher: (tabId: string) => Promise<T>, delayMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!tabId) return;
    let alive = true;
    const t = setTimeout(() => {
      fetcher(tabId)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    }, delayMs);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // fetcher is expected to be a stable module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, url, tick, delayMs]);
  return { data, error, refresh: () => setTick((n) => n + 1) };
}
