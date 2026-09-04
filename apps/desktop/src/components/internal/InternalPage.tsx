import { lazy, Suspense } from "react";
import type { Tab } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { IsolatedPanel } from "../IsolatedPanel";

/**
 * Dive's own pages live at `dive://…` and are drawn by the chrome in the
 * content area, where a web page would otherwise be. The engine keeps a
 * tab for them but no native view, so they sit in the strip, reorder,
 * split and close like any other tab.
 */

const DiveScreen = lazy(() => import("../../screen/DiveScreen").then(({ DiveScreen }) => ({ default: DiveScreen })));
const CaptureStudio = lazy(() => import("../capture/CaptureStudio").then(({ CaptureStudio }) => ({ default: CaptureStudio })));

export function isInternalUrl(url: string): boolean {
  return url.startsWith("dive://");
}

/** The DiveScreen editor for a recording at `path`. */
export function screenUrl(path: string): string {
  return `dive://screen?src=${encodeURIComponent(path)}`;
}

/** Which page a `dive://` URL names, and its query. */
export function parseInternal(url: string): { page: string; params: URLSearchParams } {
  try {
    const u = new URL(url);
    return { page: u.host, params: u.searchParams };
  } catch {
    return { page: "", params: new URLSearchParams() };
  }
}

export function InternalPage({ tab }: { tab: Tab }) {
  const { page, params } = parseInternal(tab.url);
  return (
    <div className="relative min-h-0 min-w-0 overflow-hidden bg-ground">
      <IsolatedPanel key={tab.url} label={page === "screen" ? "Recording editor" : "Capture editor"} onClose={() => void useBrowser.getState().closeTab(tab.id)}>
      <Suspense fallback={<p className="p-6 text-xs text-ink-3">Loading…</p>}>
        {page === "screen" ? (
          <DiveScreen src={params.get("src")} tabId={tab.id} />
        ) : page === "capture" ? (
          <CaptureStudio src={params.get("src")} sourceUrl={params.get("url")} sourceTitle={params.get("title")} />
        ) : (
          <Unknown page={page} />
        )}
      </Suspense>
      </IsolatedPanel>
    </div>
  );
}

function Unknown({ page }: { page: string }) {
  return (
    <div className="grid h-full place-items-center text-sm text-ink-3">
      <p>There is no built-in page called “{page}”.</p>
    </div>
  );
}
