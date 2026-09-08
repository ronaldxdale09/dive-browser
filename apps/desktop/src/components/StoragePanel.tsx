import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { ipc } from "../lib/ipc";
import { useTabData } from "../lib/useTabData";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { errorMessage } from "../lib/errors";
import { ReadError } from "./ReadError";

/**
 * Rows by key, then by their domain and path. The engine hands cookies back
 * in whatever order its store keeps them, which changed from one refresh to
 * the next, so a row the reader was looking at moved under their eyes.
 */
export function sortRows(rows: [string, string, string][]): [string, string, string][] {
  return [...rows].sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
}

/** Cookies, localStorage and sessionStorage for the active tab. */
export function StoragePanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const url = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab)?.url);
  // Cookies and storage are written as the page runs; read again once it has loaded.
  const loading = useBrowser((s) => Boolean(s.activeTab && s.loading[s.activeTab]));
  const { data, error, refresh } = useTabData(activeTab, url, ipc.tabStorage, 0, loading);
  const [section, setSection] = useState<"cookies" | "local" | "session">("cookies");

  const rows = sortRows(
    section === "cookies"
      ? (data?.cookies ?? []).map((c) => [c.name, c.value, `${c.domain}${c.path}${c.http_only ? " · HttpOnly" : ""}${c.secure ? " · Secure" : ""}${c.same_site ? ` · ${c.same_site}` : ""}`])
      : (section === "local" ? (data?.local ?? []) : (data?.session ?? [])).map(([k, v]) => [k, v, ""]),
  );
  // Delete a row: a cookie by its name, domain and path (two cookies can share a name), a key otherwise.
  const remove = (key: string, meta: string) => {
    if (!activeTab) return;
    const cookie = section === "cookies" ? (data?.cookies ?? []).find((c) => c.name === key && meta.startsWith(`${c.domain}${c.path}`)) : undefined;
    void ipc
      .tabStorageDelete(activeTab, section, key, cookie?.domain ?? null, cookie?.path ?? null)
      .then(refresh)
      .catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  };

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
        <IconButton icon={RefreshCw} label="Refresh storage" size={12} disabled={!activeTab} onClick={refresh} />
      </div>
      <div className="min-h-0 flex-1 select-text overflow-auto font-mono text-[11.5px] leading-5">
        {error && <ReadError message={error} onRetry={refresh} />}
        {!error && rows.length === 0 && <div className="px-3 py-2 text-ink-3">{activeTab ? "Nothing stored." : "Open a tab to inspect its storage."}</div>}
        {rows.length > 0 && (
          <div className="flex gap-3 border-b border-line px-3 py-0.5 font-sans text-[10px] tracking-[0.06em] text-ink-3 uppercase" aria-hidden>
            <span className="w-48 shrink-0">{section === "cookies" ? "Name" : "Key"}</span>
            <span className="min-w-0 flex-1">Value</span>
            {section === "cookies" && <span className="shrink-0">Domain · path · flags</span>}
          </div>
        )}
        {rows.map(([k, v, meta]) => (
          <div key={k + meta} className="group flex items-center gap-3 border-b border-line/60 px-3 py-0.5">
            <span className="w-48 shrink-0 truncate text-ink" title={k}>{k}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2" title={v}>{v}</span>
            {meta && <span className="shrink-0 text-ink-3">{meta}</span>}
            <button
              type="button"
              aria-label={`Delete ${k}`}
              onClick={() => remove(k, meta)}
              className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
            >
              <Icon icon={Trash2} size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
