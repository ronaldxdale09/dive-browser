import { AlertTriangle, Check, RotateCw, ShieldQuestion, WifiOff, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { createBoundsReporter, elementBounds } from "../lib/boundsReporter";
import { describeNavError } from "../lib/navError";
import { useContentPreview, useCoversContent } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import type { PermissionRequest } from "../store/browser";
import { Icon } from "./Icon";
import { selectDevice, useEmulation } from "../store/emulation";
import { useLayout, visibleSplit } from "../store/layout";
import { usePicker } from "../store/simulator";
import { DropZones, SplitView } from "./SplitView";
import { useTabDrag } from "./TabDnd";
import { InternalPage, isInternalUrl } from "./internal/InternalPage";

const DevicePicker = lazy(() => import("./simulator/DevicePicker").then(({ DevicePicker }) => ({ default: DevicePicker })));
const DeviceStage = lazy(() => import("./simulator/DeviceStage").then(({ DeviceStage }) => ({ default: DeviceStage })));
const Welcome = lazy(() => import("./Welcome").then(({ Welcome }) => ({ default: Welcome })));

/**
 * The content area. The real page is a native child webview positioned over
 * whichever element reports its rectangle: the whole area normally, one pane
 * each in a split, or the screen of a simulated device when one is chosen
 * for the active tab.
 */
export function Content() {
  const activeTab = useBrowser((s) => s.activeTab);
  const workspace = useBrowser((s) => s.activeWorkspace);
  const tabs = useBrowser((s) => s.tabs);
  const detached = useBrowser((s) => s.detached);
  const split = useLayout((s) => (workspace ? s.splits[workspace] : undefined));
  const remove = useLayout((s) => s.remove);
  const shown = visibleSplit(split, activeTab, tabs, detached);
  const sel = useEmulation(selectDevice(activeTab));
  const pickerOpen = usePicker((s) => s.open);
  // One of Dive's own pages: drawn here by the chrome, no native view.
  const internal = tabs.find((t) => t.id === activeTab && isInternalUrl(t.url));
  const dragging = useTabDrag((s) => s.dragging);
  const crash = useBrowser((s) => (activeTab ? s.crashedTabs[activeTab] : undefined));
  const navError = useBrowser((s) => (activeTab ? s.navError[activeTab] : undefined));
  const asked = useBrowser((s) => (activeTab ? s.permissionRequests[activeTab]?.[0] : undefined));
  useStartupDevice(activeTab);

  // A closed or torn-off tab leaves its split, so the split does not wait on
  // a pane that will never come back.
  useEffect(() => {
    if (!split || !workspace) return;
    const live = new Set(tabs.map((t) => t.id));
    for (const t of split.tabs) if (!live.has(t) || detached.includes(t)) remove(workspace, t);
  }, [split, workspace, tabs, detached, remove]);

  return (
    // The picker is a column beside the page, never over it: the native view
    // paints above the chrome, so anything drawn on top would be hidden — or
    // would have to hide the page, which is worse when the point of the
    // panel is to compare devices with the page showing.
    // The crash notice is a row above the page, not over it: the page's
    // rectangle is measured from the elements below, so a banner pushes the
    // native view down instead of vanishing behind it.
    <div className="relative flex min-h-0 min-w-0 flex-col bg-surface">
      {activeTab && crash && <CrashBanner attempt={crash.attempt} recovering={crash.recovering} />}
      {activeTab && <PermissionBanner key={`${activeTab}-${asked?.request_id ?? "none"}`} tabId={activeTab} request={asked} />}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="relative grid min-h-0 min-w-0 flex-1">
          {internal ? (
            <InternalPage key={internal.id} tab={internal} />
          ) : activeTab && sel ? (
            <Suspense fallback={<div className="min-h-0 bg-ground" aria-label="Loading device simulator" />}>
              <DeviceStage key={activeTab} tabId={activeTab} sel={sel} />
            </Suspense>
          ) : shown && workspace ? (
            <SplitView split={shown} workspace={workspace} />
          ) : (
            <FullPage />
          )}
          {dragging && !sel && <DropZones dragging={dragging} split={shown} activeTab={activeTab} />}
          {activeTab && navError && <NavErrorPanel url={navError.url} error={navError.error} />}
        </div>
        <Suspense fallback={pickerOpen ? <div className="h-full w-[min(420px,46%)] min-w-[300px] shrink-0 border-l border-line bg-surface" aria-label="Loading device picker" /> : null}>
          {pickerOpen && <DevicePicker />}
        </Suspense>
      </div>
    </div>
  );
}

/** The renderer died. While Dive reloads the tab this only informs; once it gives up it offers a reload. */
function CrashBanner({ attempt, recovering }: { attempt: number; recovering: boolean }) {
  const reload = useBrowser((s) => s.reload);
  return (
    <div role="status" className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 text-xs text-ink-2">
      <Icon icon={AlertTriangle} size={13} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">
        {recovering ? `This tab's renderer crashed — reloading (attempt ${attempt})` : `This tab's renderer crashed and Dive stopped reloading it after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}`}
      </span>
      {!recovering && (
        <button type="button" onClick={() => void reload()} className="flex h-6 items-center gap-1 rounded-md border border-line-2 px-2 text-ink hover:bg-surface-3">
          <Icon icon={RotateCw} size={11} /> Reload
        </button>
      )}
    </div>
  );
}

/** What a page is asking for, as the banner says it. */
export function describePermission(kind: string): string {
  switch (kind) {
    case "camera":
      return "use your camera";
    case "microphone":
      return "use your microphone";
    case "geolocation":
      return "know your location";
    case "notifications":
      return "show notifications";
    case "clipboard_read":
      return "read your clipboard";
    case "display_capture":
      return "capture your screen";
    default:
      return `use ${kind.replaceAll("_", " ")}`;
  }
}

/**
 * A page asked for a capability. A row above the page, like the crash notice:
 * the request must not hide what is asking. Allow remembers the decision but
 * the engine only applies it on the next load, so the row then offers one.
 * Keyed on the tab, so an answer given on one tab never lingers on another.
 */
function PermissionBanner({ tabId, request }: { tabId: string; request: PermissionRequest | undefined }) {
  const decide = useBrowser((s) => s.decidePermission);
  const profile = useBrowser((s) => s.profiles.find((profile) => profile.id === request?.scope.profile_id)?.name ?? "this profile");
  const [duration, setDuration] = useState<"remember" | "page">("remember");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!request) return null;
  const answer = async (decision: "allow" | "deny") => {
    setBusy(true); setError(null);
    try { await decide(tabId, request, decision, duration); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <div role="status" className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-1 text-xs text-ink-2">
      <Icon icon={ShieldQuestion} size={13} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-ink">{request.origin}</span> wants to {request.kinds.map(describePermission).join(" and ")}
        <span className="ml-2 text-ink-3">{profile} · this container</span>
      </span>
      <select aria-label="Permission duration" disabled={busy} value={duration} onChange={(e) => setDuration(e.target.value as "remember" | "page")} className="rounded-md border border-line-2 bg-surface-2 px-2 py-1 text-ink">
        <option value="remember">Remember in this profile and container</option>
        {request.page_lifetime && <option value="page">Until this page navigates or closes</option>}
      </select>
      {!request.page_lifetime && <span className="text-ink-3">This permission is remembered; page-only access is unavailable.</span>}
      <button type="button" disabled={busy} onClick={() => void answer("deny")} className="flex h-6 items-center gap-1 rounded-md border border-line-2 px-2 text-ink hover:bg-surface-3 disabled:opacity-50">
        <Icon icon={X} size={11} /> Block
      </button>
      <button type="button" disabled={busy} onClick={() => void answer("allow")} className="flex h-6 items-center gap-1 rounded-md bg-accent px-2 text-accent-ink hover:opacity-90 disabled:opacity-50">
        <Icon icon={Check} size={11} /> Allow
      </button>
      {error && <span role="alert" className="w-full text-danger">{error}</span>}
    </div>
  );
}

/**
 * What the page area shows when the document request itself failed. The
 * native view paints above the chrome, so this hides the page while it is
 * up; a retry or a new navigation takes it down.
 */
function NavErrorPanel({ url, error }: { url: string; error: string }) {
  useCoversContent(true);
  const reload = useBrowser((s) => s.reload);
  const text = describeNavError(error, url);
  const offline = /ERR_INTERNET_DISCONNECTED/.test(error);
  return (
    <div role="alert" aria-labelledby="nav-error-title" className="absolute inset-0 z-10 grid place-items-center bg-surface p-6">
      <div className="flex w-full max-w-md flex-col items-start gap-3">
        <Icon icon={offline ? WifiOff : AlertTriangle} size={28} className="text-ink-3" />
        <h2 id="nav-error-title" className="text-lg font-semibold text-ink">
          {text.title}
        </h2>
        <p className="text-sm text-ink-2">{text.detail}</p>
        {text.hint && <p className="text-sm text-ink-2">{text.hint}</p>}
        <p className="max-w-full truncate font-mono text-xs text-ink-3" title={url}>
          {url}
        </p>
        <p className="font-mono text-[11px] text-ink-3">{error}</p>
        <button type="button" onClick={() => void reload()} className="mt-1 flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm text-accent-ink hover:opacity-90">
          <Icon icon={RotateCw} size={13} /> Retry
        </button>
      </div>
    </div>
  );
}

/** The page filling the area. Reports its own rectangle. */
function FullPage() {
  const ref = useRef<HTMLDivElement>(null);
  const activeTab = useBrowser((s) => s.activeTab);
  const preview = useContentPreview(activeTab);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reporter = createBoundsReporter(
      () => elementBounds(el),
      (bounds) => void ipc.setContentBounds(bounds).catch(() => undefined),
    );
    reporter.schedule();
    const ro = new ResizeObserver(reporter.schedule);
    ro.observe(el);
    window.addEventListener("resize", reporter.schedule);
    return () => {
      reporter.dispose();
      ro.disconnect();
      window.removeEventListener("resize", reporter.schedule);
    };
  }, []);

  return (
    <div ref={ref} className="relative min-h-0 bg-surface">
      {!activeTab && (
        <Suspense fallback={<div className="absolute inset-0 bg-ground" aria-label="Loading start page" />}>
          <Welcome />
        </Suspense>
      )}
      {preview && <img aria-hidden src={preview} className="pointer-events-none absolute inset-0 size-full object-fill" />}
    </div>
  );
}

/**
 * `DIVE_SIMULATE=<preset>` puts the first active tab on that device, so a
 * smoke run or a screenshot script can bring the simulator up without a
 * click. Applied once, to whichever tab is active first.
 */
function useStartupDevice(activeTab: string | null) {
  const applied = useRef(false);
  const setDevice = useEmulation((s) => s.setDevice);
  useEffect(() => {
    if (!activeTab || applied.current) return;
    applied.current = true;
    void ipc
      .appInfo()
      .then((info) => {
        if (info.simulate) void setDevice(activeTab, info.simulate);
      })
      .catch(() => undefined);
  }, [activeTab, setDevice]);
}
