import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** Load only this window's chrome without an initial Suspense retry delay. */
export function ChromeRoot({ tabId }: { tabId: string | null }) {
  const [content, setContent] = useState<ReactNode>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = tabId
      ? import("./Popout").then(({ Popout }) => <Popout tabId={tabId} />)
      : import("../App").then(({ App }) => <App />);
    void load.then(
      (node) => { if (!cancelled) setContent(node); },
      (error: unknown) => { if (!cancelled) setFailure({ error }); },
    );
    return () => { cancelled = true; };
  }, [tabId]);

  // Throw during rendering so the existing recovery boundary handles failed
  // imports too. Retrying remounts this component and requests the module again.
  if (failure) throw failure.error;
  return content ?? <div className="h-full bg-ground" aria-label="Loading Dive" />;
}
