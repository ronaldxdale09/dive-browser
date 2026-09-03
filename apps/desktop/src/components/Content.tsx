import { useEffect, useRef } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { OrbBurst } from "./OrbBurst";

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
          <div className="flex flex-col items-center text-center">
            <OrbBurst width={220} height={220} />
            <p className="-mt-1 text-base font-semibold tracking-tight">Dive</p>
            <p className="mt-1 text-ink-3">A workspace for people who build the web.</p>
            <button
              type="button"
              onClick={() => toggle("palette", true)}
              className="mt-5 rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90"
            >
              Open a tab <kbd className="ml-1 font-mono text-[10px] opacity-60">⌘T</kbd>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
