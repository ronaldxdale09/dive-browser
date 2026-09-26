import { Check, Copy, RefreshCw, Trash2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Cookie } from "../lib/ipc";
import { useTabData } from "../lib/useTabData";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { errorMessage } from "../lib/errors";
import { copyText } from "../lib/clipboard";
import { ReadError } from "./ReadError";

type Section = "cookies" | "local" | "session";

/** One row of the panel. A cookie row keeps the cookie it came from, so deleting it names exactly that one. */
export interface StorageRow {
  key: string;
  /** The value as the host sent it: cut short past a couple of kilobytes. */
  value: string;
  /** Length of the whole value in bytes. */
  size: number;
  /** Whether `value` is only the start of it. */
  cut: boolean;
  /** Domain, path and flags, for cookies. */
  meta: string;
  cookie?: Cookie;
}

/**
 * Rows by key, then by their domain and path. The engine hands cookies back
 * in whatever order its store keeps them, which changed from one refresh to
 * the next, so a row the reader was looking at moved under their eyes.
 */
export function sortRows<T extends { key: string; meta: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.key.localeCompare(b.key) || a.meta.localeCompare(b.meta));
}

/** `12.3 kB` for a value the panel shows only the start of. */
function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const utf8 = new TextEncoder();

/** Whether the host sent only the start of a value `size` bytes long. */
function isCut(value: string, size: number): boolean {
  return size > value.length && size > utf8.encode(value).length;
}

/** A single line of `leading-5` text with `py-0.5` and the row's bottom border. */
const ROW_HEIGHT = 25;

/** Cookies, localStorage and sessionStorage for the active tab. */
export function StoragePanel() {
  const activeTab = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const tab = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? s.tabs.find((t) => t.id === id) : undefined;
  });
  const url = tab?.url;
  const sleeping = tab?.state === "discarded";
  // Cookies and storage are written as the page runs; read again once it has loaded.
  const pageLoading = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return Boolean(id && s.loading[id]);
  });
  const { data, error, loading, refresh } = useTabData(sleeping ? null : activeTab, url, ipc.tabStorage, 0, pageLoading);
  const [section, setSection] = useState<Section>("cookies");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const rows = useMemo(
    () =>
      sortRows<StorageRow>(
        section === "cookies"
          ? (data?.cookies ?? []).map((c) => ({ key: c.name, value: c.value, size: c.size, cut: isCut(c.value, c.size), meta: `${c.domain}${c.path}${c.http_only ? " · HttpOnly" : ""}${c.secure ? " · Secure" : ""}${c.same_site ? ` · ${c.same_site}` : ""}`, cookie: c }))
          : (section === "local" ? (data?.local ?? []) : (data?.session ?? [])).map((i) => ({ key: i.key, value: i.value, size: i.size, cut: isCut(i.value, i.size), meta: "" })),
      ),
    [data, section],
  );

  // Delete a row: a cookie by its own name, domain and path (two cookies can share a name), a key otherwise.
  const remove = (row: StorageRow) => {
    if (!activeTab) return;
    void ipc
      .tabStorageDelete(activeTab, section, row.key, row.cookie?.domain ?? null, row.cookie?.path ?? null)
      .then(refresh)
      .catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  };
  // Copy the whole value. What the row holds may be only its start, so a
  // long one is read again in full rather than copied cut short.
  const copy = async (row: StorageRow, id: string) => {
    if (!activeTab) return;
    try {
      const full = row.cut ? await ipc.tabStorageValue(activeTab, section, row.key, row.cookie?.domain ?? null, row.cookie?.path ?? null) : row.value;
      if (full === null) {
        useBrowser.getState().notify(`${row.key} is not stored any more`, 4000);
        refresh();
        return;
      }
      await copyText(full);
      setCopied(id);
    } catch (e) {
      useBrowser.getState().notify(`Could not copy: ${errorMessage(e)}`, 4000);
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  // The React Compiler is not in use here; the virtualizer's mutable instance is intended.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => (rows[i] ? `${rows[i].key}\u0000${rows[i].meta}` : i),
  });

  if (sleeping) return <div className="px-3 py-2 text-xs text-ink-3">This tab is sleeping. Wake it to inspect this page&rsquo;s storage.</div>;

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
      {error && <ReadError message={error} onRetry={refresh} />}
      {!error && rows.length === 0 && <div className="px-3 py-2 font-mono text-[11.5px] text-ink-3">{!activeTab ? "Open a tab to inspect its storage." : loading ? "Reading…" : "Nothing stored."}</div>}
      {rows.length > 0 && (
        <div className="flex gap-3 border-b border-line px-3 py-0.5 font-sans text-[10px] tracking-[0.06em] text-ink-3 uppercase" aria-hidden>
          <span className="w-48 shrink-0">{section === "cookies" ? "Name" : "Key"}</span>
          <span className="min-w-0 flex-1">Value</span>
          {section === "cookies" && <span className="shrink-0">Domain · path · flags</span>}
        </div>
      )}
      <div ref={scrollRef} data-testid="storage-scroll" className="min-h-0 flex-1 select-text overflow-auto font-mono text-[11.5px] leading-5">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]!;
            const id = String(v.key);
            return (
              <div
                key={id}
                ref={virtualizer.measureElement}
                data-index={v.index}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
                className="group flex items-center gap-3 border-b border-line/60 px-3 py-0.5"
              >
                <span className="w-48 shrink-0 truncate text-ink" title={row.key}>{row.key}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2" title={row.cut ? `${row.value.slice(0, 300)}… (${bytes(row.size)})` : row.value}>
                  {row.value}
                </span>
                {row.cut && <span className="shrink-0 text-[10px] text-ink-3">{bytes(row.size)}</span>}
                {row.meta && <span className="shrink-0 text-ink-3">{row.meta}</span>}
                <button
                  type="button"
                  aria-label={copied === id ? `Copied ${row.key}` : `Copy the value of ${row.key}`}
                  title={copied === id ? "Copied" : "Copy the whole value"}
                  onClick={() => void copy(row, id)}
                  className={`grid size-5 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100 ${copied === id ? "opacity-100" : "opacity-0"}`}
                >
                  <Icon icon={copied === id ? Check : Copy} size={11} className={copied === id ? "text-highlight" : undefined} />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${row.key}`}
                  onClick={() => remove(row)}
                  className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                >
                  <Icon icon={Trash2} size={11} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
