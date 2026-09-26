import { useEffect, useRef } from "react";
import { RETRY_DELAYS, retryPolicy } from "./navError";

/**
 * How far automatic retries of one failed address in one tab have got.
 *
 * Kept outside the panel: a retry takes the error panel down (the load
 * starts), and a retry that fails again puts a new one up. Counted per
 * panel, every failure would start the schedule over and the page would be
 * reloaded every two seconds for as long as the network stayed down.
 */
type Progress = { url: string; attempt: number };
const progress = new Map<string, Progress>();

/** The next timed retry for `tabId` at `url`, in seconds, or null once the schedule is spent. */
export function nextRetryDelay(tabId: string, url: string): number | null {
  const current = progress.get(tabId);
  const attempt = current?.url === url ? current.attempt : 0;
  return RETRY_DELAYS[attempt] ?? null;
}

/** A timed retry of `tabId` at `url` was made. */
export function noteRetry(tabId: string, url: string): void {
  const current = progress.get(tabId);
  progress.set(tabId, { url, attempt: current?.url === url ? current.attempt + 1 : 1 });
}

/** Start the schedule over: the person pressed Retry, or the network came back. */
export function resetRetries(tabId: string): void {
  progress.delete(tabId);
}

/**
 * Retry a page that failed for want of a network, without being asked:
 * once when the system says the network is back, and for the errors that
 * are nearly always the network, a few more times on a short timer. Only
 * while the page is the one being looked at, in a window that is visible;
 * never for a form's answer or a certificate error (see `retryPolicy`).
 */
export function useAutoRetry({ tabId, url, error, method, active, retry }: { tabId: string | null; url: string; error: string; method?: string | undefined; active: boolean; retry: () => void }) {
  const retryRef = useRef(retry);
  useEffect(() => {
    retryRef.current = retry;
  });
  useEffect(() => {
    const policy = retryPolicy(error, method);
    if (!tabId || !active || policy === "never") return;
    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (policy !== "backoff") return;
      const delay = nextRetryDelay(tabId, url);
      if (delay === null) return;
      timer = setTimeout(() => {
        timer = null;
        // A hidden window waits: the retry is for someone watching, and it
        // is made when they come back instead.
        if (!visible()) return;
        noteRetry(tabId, url);
        retryRef.current();
      }, delay * 1000);
    };
    const onOnline = () => {
      if (!visible()) return;
      // The network is back: that is a new chance, so the timer's budget
      // starts over as well.
      resetRetries(tabId);
      retryRef.current();
    };
    const onVisible = () => {
      if (visible() && timer === null) schedule();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tabId, url, error, method, active]);
}
