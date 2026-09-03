import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { StorageSnapshot } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { IconButton } from "./Icon";

/** Cookies, localStorage and sessionStorage for the active tab. */
export function StoragePanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const url = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab)?.url);
  const [data, setData] = useState<StorageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<"cookies" | "local" | "session">("cookies");
  const [tick, setTick] = useState(0);

  // Re-read whenever the tab, its URL, or the refresh counter changes.
  useEffect(() => {
    if (!activeTab) return;
    let alive = true;
    ipc
      .tabStorage(activeTab)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [activeTab, url, tick]);

  const rows: [string, string, string][] =
    section === "cookies"
      ? (data?.cookies ?? []).map((c) => [c.name, c.value, `${c.domain}${c.path}${c.http_only ? " · HttpOnly" : ""}${c.secure ? " · Secure" : ""}${c.same_site ? ` · ${c.same_site}` : ""}`])
      : (section === "local" ? (data?.local ?? []) : (data?.session ?? [])).map(([k, v]) => [k, v, ""]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-1">
        {(["cookies", "local", "session"] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={section === s}
            onClick={() => setSection(s)}
            className="h-6 rounded-full px-2.5 text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-3 aria-pressed:text-ink"
          >
            {s === "cookies" ? `Cookies (${data?.cookies.length ?? 0})` : s === "local" ? `Local (${data?.local.length ?? 0})` : `Session (${data?.session.length ?? 0})`}
          </button>
        ))}
        <span className="flex-1" />
        <IconButton icon={RefreshCw} label="Refresh storage" size={12} disabled={!activeTab} onClick={() => setTick((t) => t + 1)} />
      </div>
      <div className="min-h-0 flex-1 select-text overflow-auto font-mono text-[11.5px] leading-5">
        {error && <div className="px-3 py-2 text-danger">{error}</div>}
        {!error && rows.length === 0 && <div className="px-3 py-2 text-ink-3">{activeTab ? "Nothing stored." : "Open a tab to inspect its storage."}</div>}
        {rows.map(([k, v, meta]) => (
          <div key={k + meta} className="flex gap-3 border-b border-line/60 px-3 py-0.5">
            <span className="w-48 shrink-0 truncate text-ink" title={k}>{k}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2" title={v}>{v}</span>
            {meta && <span className="shrink-0 text-ink-3">{meta}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
