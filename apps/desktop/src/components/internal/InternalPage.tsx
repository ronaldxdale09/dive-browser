import { FileQuestion, House, X } from "lucide-react";
import { lazy, Suspense } from "react";
import { runCommand } from "../../lib/commands";
import { Icon } from "../Icon";
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
      <IsolatedPanel key={tab.url} label={page === "screen" ? "Recording editor" : page === "capture" ? "Capture editor" : "Dive page"} onClose={() => void useBrowser.getState().closeTab(tab.id)}>
      <Suspense fallback={<p className="p-6 text-xs text-ink-3">Loading…</p>}>
        {page === "screen" ? (
          <DiveScreen src={params.get("src")} tabId={tab.id} />
        ) : page === "capture" ? (
          <CaptureStudio src={params.get("src")} sourceUrl={params.get("url")} sourceTitle={params.get("title")} />
        ) : (
          <Unknown page={page} tabId={tab.id} />
        )}
      </Suspense>
      </IsolatedPanel>
    </div>
  );
}

/**
 * A dive:// address that names no page (a typo, or a link from an older
 * build). It has no native view and no address history of its own to go
 * back through, so it offers the ways out rather than leaving a dead end.
 */
function Unknown({ page, tabId }: { page: string; tabId: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-ink-3">
          <Icon icon={FileQuestion} size={18} />
        </span>
        <p className="text-sm text-ink">{page ? <>There is no built-in page called “{page}”.</> : "This is not a Dive page."}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button type="button" onClick={() => runCommand("tab.home")} className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-accent-ink hover:opacity-90">
            <Icon icon={House} size={13} /> Go home
          </button>
          <button type="button" onClick={() => void useBrowser.getState().closeTab(tabId)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line-2 px-3 text-xs text-ink hover:bg-surface-2">
            <Icon icon={X} size={13} /> Close tab
          </button>
        </div>
      </div>
    </div>
  );
}
