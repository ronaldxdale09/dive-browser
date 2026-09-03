import { useEffect, useRef } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Welcome } from "./Welcome";

/**
 * Placeholder for the engine view. The real page is a native child webview
 * positioned over this element, so this only reports its rectangle.
 */
export function Content() {
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
