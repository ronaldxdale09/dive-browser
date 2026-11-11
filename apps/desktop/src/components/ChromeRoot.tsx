import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { bootMark } from "../lib/bootMarks";

let started: { key: string; load: Promise<ReactNode> } | null = null;

/**
 * Start fetching this window's chrome. Called from `main.tsx` before the
 * saved UI state has loaded, so the module download overlaps that IPC; the
 * component below picks up the same promise. A failed load is forgotten so
 * "Try again" fetches afresh.
 */
export function preloadChrome(tabId: string | null, appId: string | null = null): Promise<ReactNode> {
  const key = `${tabId ?? ""}\n${appId ?? ""}`;
  if (started?.key === key) return started.load;
  // An installed app's window names the app as well as the tab, and gets
  // the app chrome instead of the popout's tab strip.
  const load = tabId && appId
    ? import("./AppWindow").then(({ AppWindow }) => <AppWindow tabId={tabId} appId={appId} />)
    : tabId
      ? import("./Popout").then(({ Popout }) => <Popout tabId={tabId} />)
      : import("../App").then(({ App }) => {
        bootMark("app_module_loaded");
        return <App />;
      });
  const entry = { key, load };
  started = entry;
  load.catch(() => {
    if (started === entry) started = null;
  });
  return load;
}

/** Forget any started load; for tests. */
export function resetChromePreload(): void {
  started = null;
}

/** Load only this window's chrome without an initial Suspense retry delay. */
export function ChromeRoot({ tabId, appId = null }: { tabId: string | null; appId?: string | null }) {
  const [content, setContent] = useState<ReactNode>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = preloadChrome(tabId, appId);
    void load.then(
      (node) => { if (!cancelled) setContent(node); },
      (error: unknown) => { if (!cancelled) setFailure({ error }); },
    );
    return () => { cancelled = true; };
  }, [tabId, appId]);

  useEffect(() => {
    if (content && !tabId) bootMark("app_rendered");
  }, [content, tabId]);

  // Throw during rendering so the existing recovery boundary handles failed
  // imports too. Retrying remounts this component and requests the module again.
  if (failure) throw failure.error;
  return content ?? <div className="h-full bg-ground" aria-label="Loading Dive" />;
}
