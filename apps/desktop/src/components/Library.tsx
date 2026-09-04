import { History, Search, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Bookmark, HistoryEntry } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { Favicon } from "./Favicon";
import { Icon, IconButton } from "./Icon";

/** How many rows each list loads; the filter box narrows from there. */
export const LIBRARY_LIMIT = 200;

type LibraryTab = "bookmarks" | "history";

/** Bookmarks and history in one dialog: ⌘Y. */
export function Library() {
  useCoversContent(true);
  const toggle = useBrowser((s) => s.toggle);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { close, className } = useFadeClose(() => toggle("library", false));
  useFocusTrap(root, { initialFocus: input, onEscape: close });
  const [tab, setTab] = useState<LibraryTab>("bookmarks");
  const [query, setQuery] = useState("");

  return (
    <div ref={root} className={`fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-[2px] ${className}`} onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Library"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[min(620px,88vh)] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
          <div role="tablist" aria-label="Library sections" className="flex items-center gap-0.5">
            {(["bookmarks", "history"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`library-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`library-panel-${id}`}
                onClick={() => setTab(id)}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink aria-selected:bg-surface-3 aria-selected:text-ink"
              >
                <Icon icon={id === "bookmarks" ? Star : History} size={13} />
                {id === "bookmarks" ? "Bookmarks" : "History"}
              </button>
            ))}
          </div>
          <label className="mx-2 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 focus-within:border-line-2">
            <Icon icon={Search} size={13} className="shrink-0 text-ink-3" />
            <input
              ref={input}
              aria-label={tab === "bookmarks" ? "Filter bookmarks" : "Filter history"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === "bookmarks" ? "Filter bookmarks" : "Filter history"}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <IconButton icon={X} label="Close library" onClick={close} />
        </header>
        <div role="tabpanel" id={`library-panel-${tab}`} aria-labelledby={`library-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto p-2">
          {tab === "bookmarks" ? <Bookmarks query={query} onOpened={close} /> : <HistoryList query={query} onOpened={close} />}
        </div>
      </div>
    </div>
  );
}

/** Case-insensitive match on title or URL. */
export function matches(query: string, title: string, url: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || title.toLowerCase().includes(q) || url.toLowerCase().includes(q);
}

/** Open a row: in the current tab by default, a new one with the platform modifier. */
function useOpenRow(onOpened: () => void) {
  const navigate = useBrowser((s) => s.navigate);
  const openTab = useBrowser((s) => s.openTab);
  return (e: React.MouseEvent, url: string) => {
    onOpened();
    void (e.metaKey || e.ctrlKey ? openTab(url) : navigate(url));
  };
}

function Bookmarks({ query, onOpened }: { query: string; onOpened: () => void }) {
  const [items, setItems] = useState<Bookmark[] | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .bookmarksSearch("", LIBRARY_LIMIT)
      .then((b) => alive && setItems(b))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);
  const open = useOpenRow(onOpened);
  const shown = (items ?? []).filter((b) => matches(query, b.title, b.url));
  const remove = (url: string) => {
    setItems((list) => (list ?? []).filter((b) => b.url !== url));
    void ipc.bookmarkRemove(url).catch(() => undefined);
  };
  if (items === null) return <p className="p-3 text-xs text-ink-3">Loading…</p>;
  if (shown.length === 0) return <Empty>{items.length === 0 ? "No bookmarks yet. Star a page from the address bar to keep it here." : "Nothing matches."}</Empty>;
  return (
    <ul className="flex flex-col">
      {shown.map((b) => (
        <li key={b.url} className="group flex items-center gap-1">
          <button type="button" onClick={(e) => open(e, b.url)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
            <Favicon src={b.favicon} size={14} fallback={Star} fallbackClassName="text-highlight" />
            <span className="truncate text-ink">{b.title || b.url}</span>
            <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(b.url)}</span>
          </button>
          <button
            type="button"
            aria-label={`Remove bookmark ${b.title || b.url}`}
            onClick={() => remove(b.url)}
            className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
          >
            <Icon icon={Trash2} size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Calendar day of an RFC 3339 time, as the heading history groups under. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** History rows in the order given, bucketed by day; days keep first-seen order. */
export function groupByDay(entries: HistoryEntry[], now: Date = new Date()): { day: string; entries: HistoryEntry[] }[] {
  const groups: { day: string; entries: HistoryEntry[] }[] = [];
  for (const e of entries) {
    const day = dayLabel(e.last_visited_at, now);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else groups.push({ day, entries: [e] });
  }
  return groups;
}

function HistoryList({ query, onOpened }: { query: string; onOpened: () => void }) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const openSettings = useBrowser((s) => s.openSettings);
  useEffect(() => {
    let alive = true;
    ipc
      .historySearch("", LIBRARY_LIMIT)
      .then((h) => alive && setItems(h))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);
  const open = useOpenRow(onOpened);
  const groups = useMemo(() => groupByDay((items ?? []).filter((h) => matches(query, h.title, h.url))), [items, query]);
  return (
    <>
      <div className="flex items-center justify-between px-2.5 pt-1 pb-2">
        <span className="text-[11px] text-ink-3">{items === null ? "Loading…" : `${items.length} ${items.length === 1 ? "page" : "pages"}`}</span>
        <button
          type="button"
          onClick={() => {
            onOpened();
            openSettings("privacy");
          }}
          className="h-7 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink"
        >
          Clear browsing data…
        </button>
      </div>
      {items !== null && groups.length === 0 && <Empty>{items.length === 0 ? "No history yet." : "Nothing matches."}</Empty>}
      {groups.map((g) => (
        <section key={g.day} aria-label={g.day} className="mb-2">
          <h4 className="px-2.5 py-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{g.day}</h4>
          <ul className="flex flex-col">
            {g.entries.map((h) => (
              <li key={h.url}>
                <button type="button" onClick={(e) => open(e, h.url)} className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
                  <Favicon src={h.favicon} size={14} fallback={History} />
                  <span className="truncate text-ink">{h.title || h.url}</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(h.url)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-3 text-xs text-ink-3">{children}</p>;
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
