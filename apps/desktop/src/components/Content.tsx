import { AlertTriangle, RotateCw, WifiOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { ipc } from "../lib/ipc";
import { describeNavError } from "../lib/navError";
import { useCoversContent } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { selectDevice, useEmulation } from "../store/emulation";
import { useLayout, visibleSplit } from "../store/layout";
import { Welcome } from "./Welcome";
import { DevicePicker } from "./simulator/DevicePicker";
import { DeviceStage } from "./simulator/DeviceStage";
import { DropZones, SplitView } from "./SplitView";
import { useTabDrag } from "./TabDnd";

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
  const dragging = useTabDrag((s) => s.dragging);
  const crash = useBrowser((s) => (activeTab ? s.crashedTabs[activeTab] : undefined));
  const navError = useBrowser((s) => (activeTab ? s.navError[activeTab] : undefined));
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
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="relative grid min-h-0 min-w-0 flex-1">
          {activeTab && sel ? <DeviceStage key={activeTab} tabId={activeTab} sel={sel} /> : shown && workspace ? <SplitView split={shown} workspace={workspace} /> : <FullPage />}
          {dragging && !sel && <DropZones dragging={dragging} split={shown} activeTab={activeTab} />}
          {activeTab && navError && <NavErrorPanel url={navError.url} error={navError.error} />}
        </div>
        <DevicePicker />
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

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void ipc.setContentBounds({ x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => undefined);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, []);

  return (
    <div ref={ref} className="relative min-h-0 bg-surface">
      {!activeTab && <Welcome />}
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
