import { useEffect, useRef } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
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
    <div className="relative flex min-h-0 min-w-0 bg-surface">
      <div className="relative grid min-h-0 min-w-0 flex-1">
        {activeTab && sel ? <DeviceStage key={activeTab} tabId={activeTab} sel={sel} /> : shown && workspace ? <SplitView split={shown} workspace={workspace} /> : <FullPage />}
        {dragging && !sel && <DropZones dragging={dragging} split={shown} activeTab={activeTab} />}
      </div>
      <DevicePicker />
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
