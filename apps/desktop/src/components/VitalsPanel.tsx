import { RefreshCw } from "lucide-react";
import { ipc } from "../lib/ipc";
import { useTabData } from "../lib/useTabData";
import type { Vitals } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { IconButton } from "./Icon";
import { InternalPageNote, isInternalPage } from "./InternalPageNote";

type Rating = "good" | "needs-improvement" | "poor" | "unknown";

/** Google's thresholds. */
export function rate(metric: keyof Vitals, value: number | null | undefined): Rating {
  if (value === null || value === undefined) return "unknown";
  const t: Partial<Record<keyof Vitals, [number, number]>> = { lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], cls: [0.1, 0.25], inp: [200, 500] };
  const th = t[metric];
  if (!th) return "unknown";
  return value <= th[0] ? "good" : value <= th[1] ? "needs-improvement" : "poor";
}

const COLOR: Record<Rating, string> = { good: "text-[#6cc493]", "needs-improvement": "text-[#f0b35e]", poor: "text-danger", unknown: "text-ink-3" };

function fmt(metric: keyof Vitals, v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  if (metric === "cls") return v.toFixed(3);
  if (metric === "transfer_size") return v < 1024 ? `${v} B` : `${(v / 1024).toFixed(1)} kB`;
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

const TILES: { key: keyof Vitals; label: string; hint: string }[] = [
  { key: "lcp", label: "LCP", hint: "Largest Contentful Paint" },
  { key: "inp", label: "INP", hint: "Interaction to Next Paint (needs input)" },
  { key: "cls", label: "CLS", hint: "Cumulative Layout Shift" },
  { key: "fcp", label: "FCP", hint: "First Contentful Paint" },
  { key: "ttfb", label: "TTFB", hint: "Time to First Byte" },
  { key: "dcl", label: "DCL", hint: "DOMContentLoaded" },
  { key: "load", label: "Load", hint: "Load event end" },
  { key: "transfer_size", label: "Doc size", hint: "Document transfer size" },
];

/** Core Web Vitals from the page's buffered performance entries. */
export function VitalsPanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const url = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab)?.url);
  // Load-event timings only exist once the page has finished loading, so
  // read again when the spinner stops instead of leaving them blank.
  const loading = useBrowser((s) => Boolean(s.activeTab && s.loading[s.activeTab]));
  const internal = isInternalPage(url);
  const { data, error, refresh } = useTabData(internal ? null : activeTab, url, ipc.tabVitals, 600, loading);

  if (internal) return <InternalPageNote what="Web Vitals" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-ink-3">
        <span>{loading ? "Measuring while the page loads…" : data?.lcp_element ? `LCP element: ${data.lcp_element}` : "Reload the page to measure a fresh navigation."}</span>
        <span className="flex-1" />
        <IconButton icon={RefreshCw} label="Re-read vitals" size={12} disabled={!activeTab} onClick={refresh} tooltipAlign="end" />
      </div>
      {error && <div className="px-3 py-2 text-xs text-danger">{error}</div>}
      <div className="grid grid-cols-4 gap-2 overflow-auto px-3 py-2">
        {TILES.map(({ key, label, hint }) => {
          const value = data?.[key];
          const r = rate(key, typeof value === "number" ? value : null);
          return (
            <div key={key} className="rounded-lg border border-line bg-surface-2 px-3 py-2" title={hint}>
              <div className="text-[10px] tracking-wider text-ink-3 uppercase">{label}</div>
              <div className={`font-mono text-lg tabular-nums ${COLOR[r]}`}>{fmt(key, typeof value === "number" ? value : null)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
