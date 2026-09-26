import { useEffect, useState } from "react";
import { errorMessage } from "./errors";

/**
 * A read that failed only because the page was mid-navigation when the
 * inspector asked. The page will be there a moment later, so it is worth
 * one more try before anything is shown.
 */
export function isTransientReadError(message: string): boolean {
  return /navigated or closed|Not attached to an active page|target closed|session closed/i.test(message);
}

/** What the panels say instead of a raw protocol error. */
export function readErrorText(message: string): string {
  return isTransientReadError(message) ? "The page was still loading when it was read." : message;
}

const RETRY_MS = 700;

/**
 * Fetch something about the active tab whenever the tab or its URL changes,
 * with a manual refresh and stale-response protection. Shared by the dock
 * panels that read page state on demand. `revision` is any extra value
 * whose change should re-read too, such as the tab finishing a load.
 */
export function useTabData<T>(tabId: string | null, url: string | undefined, fetcher: (tabId: string) => Promise<T>, delayMs = 0, revision: unknown = null) {
  // Answers remember which tab and which page they belong to, so a tab that
  // has gone (the welcome screen) shows nothing rather than the last page's
  // numbers, and a tab that navigated does not show the page it left while
  // the new one is read.
  const [answer, setAnswer] = useState<{ tabId: string; url: string | undefined; data: T | null; error: string | null }>({ tabId: "", url: undefined, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!tabId) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = (again: boolean) =>
      fetcher(tabId)
        .then((d) => alive && setAnswer({ tabId, url, data: d, error: null }))
        .catch((e: unknown) => {
          if (!alive) return;
          const message = errorMessage(e);
          if (again && isTransientReadError(message)) {
            retry = setTimeout(() => read(false), RETRY_MS);
            return;
          }
          setAnswer((old) => ({ tabId, url, data: old.tabId === tabId && old.url === url ? old.data : null, error: readErrorText(message) }));
        });
    const t = setTimeout(() => read(true), delayMs);
    return () => {
      alive = false;
      clearTimeout(t);
      if (retry) clearTimeout(retry);
    };
    // fetcher is expected to be a stable module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, url, tick, delayMs, revision]);
  const current = tabId !== null && answer.tabId === tabId && answer.url === url;
  return {
    data: current ? answer.data : null,
    error: current ? answer.error : null,
    // Nothing read yet for this page. The panels say so, rather than show an
    // empty result that reads as "there is nothing here".
    loading: tabId !== null && !current,
    refresh: () => setTick((n) => n + 1),
  };
}
