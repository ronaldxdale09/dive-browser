import { Locate, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ipc } from "../lib/ipc";
import { useTabData } from "../lib/useTabData";
import type { Vitals } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { InternalPageNote, isInternalPage } from "./InternalPageNote";
import { ReadError } from "./ReadError";

type Rating = "good" | "needs-improvement" | "poor" | "unknown";

/** Google's thresholds. */
export function rate(metric: keyof Vitals, value: number | null | undefined): Rating {
  if (value === null || value === undefined) return "unknown";
  const t: Partial<Record<keyof Vitals, [number, number]>> = { lcp: [2500, 4000], fcp: [1800, 3000], ttfb: [800, 1800], cls: [0.1, 0.25], inp: [200, 500] };
  const th = t[metric];
  if (!th) return "unknown";
  return value <= th[0] ? "good" : value <= th[1] ? "needs-improvement" : "poor";
}

const COLOR: Record<Rating, string> = { good: "text-good", "needs-improvement": "text-warn", poor: "text-danger", unknown: "text-ink-3" };

/** The rating in words, so colour is never the only signal. */
export function ratingLabel(metric: keyof Vitals, value: number | null | undefined): string {
  const r = rate(metric, value);
  if (r === "good") return "good";
  if (r === "needs-improvement") return "needs work";
  if (r === "poor") return "poor";
  return metric === "inp" && (value === null || value === undefined) ? "no input yet" : "";
}

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
  const [lcpGone, setLcpGone] = useState(false);

  // Scroll the page to the LCP element and flash it, the way A11y findings do.
  const showLcp = async () => {
    if (!activeTab || !data?.lcp_element) return;
    try {
      setLcpGone(!(await ipc.tabA11yReveal(activeTab, data.lcp_element)));
    } catch {
      setLcpGone(true);
    }
  };

  if (internal) return <InternalPageNote what="Web Vitals" />;
  if (!activeTab) return <div className="px-3 py-2 text-xs text-ink-3">Open a tab to measure its Web Vitals.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-ink-3">
        {loading ? (
          <span>Measuring while the page loads…</span>
        ) : data?.lcp_element ? (
          <button
            type="button"
            onClick={() => void showLcp()}
            className="flex min-w-0 items-center gap-1.5 rounded text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-highlight"
            aria-label={`Show the LCP element ${data.lcp_element} in the page`}
            title="Scroll the page to the largest contentful paint element"
          >
            <Icon icon={Locate} size={11} className="shrink-0" />
            <span className="truncate">LCP element: <span className="font-mono">{data.lcp_element}</span></span>
            {lcpGone && <span className="shrink-0 text-warn">(not on the page now)</span>}
          </button>
        ) : (
          <span>Reload the page to measure a fresh navigation.</span>
        )}
        <span className="flex-1" />
        <IconButton icon={RefreshCw} label="Re-read vitals" size={12} disabled={!activeTab} onClick={refresh} tooltipAlign="end" />
      </div>
      {error && <ReadError message={error} onRetry={refresh} />}
      <div className="grid grid-cols-4 gap-2 overflow-auto px-3 py-2">
        {TILES.map(({ key, label, hint }) => {
          const value = data?.[key];
          const n = typeof value === "number" ? value : null;
          const r = rate(key, n);
          const word = ratingLabel(key, n);
          return (
            <div key={key} className="rounded-lg border border-line bg-surface-2 px-3 py-2" title={hint} aria-label={`${hint}: ${fmt(key, n)}${word ? `, ${word}` : ""}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] tracking-wider text-ink-3 uppercase">{label}</span>
                {word && <span className={`text-[10px] ${COLOR[r]}`}>{word}</span>}
              </div>
              <div className={`font-mono text-lg tabular-nums ${COLOR[r]}`}>{fmt(key, n)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
