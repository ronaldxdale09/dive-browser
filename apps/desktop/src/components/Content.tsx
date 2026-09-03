import { useEffect, useRef } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";

/**
 * Placeholder for the engine view. The real page is a native child webview
 * positioned over this element, so this only reports its rectangle.
 */
export function Content() {
  const ref = useRef<HTMLDivElement>(null);
  const activeTab = useBrowser((s) => s.activeTab);
  const toggle = useBrowser((s) => s.toggle);

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
      {!activeTab && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="text-lg font-semibold tracking-tight">Dive</p>
            <p className="mt-1 text-ink-3">Press ⌘T to open a tab</p>
            <button type="button" onClick={() => toggle("palette", true)} className="mt-4 rounded-md bg-accent px-3 py-1.5 text-xs text-white">
              New tab
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
