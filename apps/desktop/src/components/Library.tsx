import { titleOf } from "../lib/omnibox";
import { AlertTriangle, AppWindow, Clapperboard, Download, FolderOpen, History, LayoutGrid, Pencil, RotateCw, Search, Star, Trash2, Wand2, X } from "lucide-react";
import { useWebAppIcon } from "../lib/useWebAppIcon";
import { WEBAPPS_CHANGED, useWebApps } from "../store/webapps";
import type { WebApp } from "../lib/ipc";
import { displayChord, BOOKMARKS_CHANGED, fileManagerName } from "../lib/commands";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ipc } from "../lib/ipc";
import type { Bookmark, DownloadRecord, HistoryEntry, RecordingInfo } from "../lib/ipc";
import { renameBookmark } from "../lib/bookmarks";
import { recordingBytes } from "../lib/recordingFormat";
import { useDownloads } from "../store/downloads";
import { screenUrl } from "./internal/InternalPage";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { isPrivateWindow } from "../lib/privateMode";
import { IMPORT_BUSY, useImportVideo } from "../screen/importVideo";
import { OpenVideoButton } from "../screen/OpenVideoButton";
import { EmptyState } from "./EmptyState";
import { errorMessage } from "../lib/errors";
import { fileNameOr, fileUrl, opensInTab } from "../lib/paths";
import { downloadStatus, downloadStatusLabel } from "../store/downloads";
import type { Download as LiveDownload } from "../store/downloads";
import { Favicon } from "./Favicon";
import { Icon, IconButton } from "./Icon";

/** How many rows each list asks for at a time; scrolling to the end asks for the next page. */
export const LIBRARY_LIMIT = 200;
/** The furthest a list pages in, matching the host's own cap. A filter still searches everything. */
export const LIBRARY_MAX = 5000;
/** How long typing in the filter settles before the host is asked. */
export const FILTER_DEBOUNCE_MS = 150;

export { downloadStatusLabel };

type LibraryTab = "bookmarks" | "history" | "downloads" | "recordings" | "apps";
const TABS: { id: LibraryTab; label: string; icon: typeof Star }[] = [
  { id: "bookmarks", label: "Bookmarks", icon: Star },
  { id: "history", label: "History", icon: History },
  { id: "downloads", label: "Downloads", icon: Download },
  { id: "recordings", label: "Recordings", icon: Clapperboard },
  { id: "apps", label: "Apps", icon: LayoutGrid },
];

/** Bookmarks and history in one dialog: ⌘Y. */
/** What a row is called: its title, or its address when the page never gave one (older rows may still say "about:blank"). */
export { titleOf };

export function Library() {
  useCoversContent(true);
  const toggle = useBrowser((s) => s.toggle);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { close, className } = useFadeClose(() => toggle("library", false));
  useFocusTrap(root, { initialFocus: input, onEscape: close });
  const initial = useBrowser((s) => s.libraryTab);
  // A private window keeps no bookmarks or history; its library is files.
  const tabs = isPrivateWindow() ? TABS.filter((t) => t.id === "downloads" || t.id === "recordings") : TABS;
  const [tab, setTab] = useState<LibraryTab>(() => (tabs.some((t) => t.id === initial) ? initial : tabs[0]!.id));
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 grid place-items-center ${className}`} onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Library"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[min(620px,88vh)] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
          <div role="tablist" aria-label="Library sections" className="flex items-center gap-0.5">
            {tabs.map(({ id, label, icon }) => (
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
                <Icon icon={icon} size={13} />
                {label}
              </button>
            ))}
          </div>
          <label className="mx-2 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 focus-within:border-line-2">
            <Icon icon={Search} size={13} className="shrink-0 text-ink-3" />
            <input
              ref={input}
              aria-label={`Filter ${tab}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${tab}`}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <IconButton icon={X} label="Close library" onClick={close} />
        </header>
        <div key={tab} ref={panelRef} role="tabpanel" id={`library-panel-${tab}`} aria-labelledby={`library-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto p-2">
          {tab === "bookmarks" ? <Bookmarks query={query} onOpened={close} scrollRef={panelRef} /> : tab === "history" ? <HistoryList query={query} onOpened={close} /> : tab === "downloads" ? <DownloadsList query={query} onOpened={close} /> : tab === "apps" ? <Apps query={query} onOpened={close} /> : <Recordings query={query} onOpened={close} />}
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

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Hover name for a clipped Library row: the page, and its host when that is different. */
export function libraryRowTitle(name: string, url: string): string {
  const place = host(url);
  return place && place !== name ? `${name} — ${place}` : name;
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

/**
 * A list the host searches, a page at a time. The filter goes to the host
 * (debounced) rather than narrowing what was loaded: filtering the newest 200
 * in the chrome could never find the bookmark saved last year.
 */
export function usePagedSearch<T>(search: (query: string, limit: number) => Promise<T[]>, query: string) {
  const [settled, setSettled] = useState(query.trim());
  useEffect(() => {
    const next = query.trim();
    if (next === settled) return;
    const timer = setTimeout(() => setSettled(next), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, settled]);
  // Pages are counted per query, so a new filter starts again at one page.
  const [pages, setPages] = useState({ query: settled, count: 1 });
  const count = pages.query === settled ? pages.count : 1;
  const limit = Math.min(LIBRARY_LIMIT * count, LIBRARY_MAX);
  const [items, setItems] = useState<T[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Which request the list on screen answers; any other one is still loading.
  const request = `${settled}\n${limit}\n${attempt}`;
  const [answered, setAnswered] = useState<string | null>(null);
  const loading = answered !== request;
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });
  useEffect(() => {
    let alive = true;
    searchRef.current(settled, limit)
      .then((found) => {
        if (!alive) return;
        setItems(found);
        setLoadError(null);
      })
      .catch((e: unknown) => alive && setLoadError(errorMessage(e)))
      .finally(() => alive && setAnswered(`${settled}\n${limit}\n${attempt}`));
    return () => {
      alive = false;
    };
  }, [settled, limit, attempt]);
  // A full page may have more behind it; a short one is the end.
  const more = items !== null && items.length >= limit && limit < LIBRARY_MAX;
  const loadMore = useCallback(() => {
    if (!more || loading) return;
    setPages({ query: settled, count: count + 1 });
  }, [more, loading, settled, count]);
  return {
    items,
    setItems,
    loadError,
    loading,
    retry: () => setAttempt((n) => n + 1),
    more,
    loadMore,
    /** The list reached the furthest it pages and there may be more. */
    capped: items !== null && limit >= LIBRARY_MAX && items.length >= LIBRARY_MAX,
    filtered: settled !== "",
  };
}

/** "200+ bookmarks", "12 matching": a count that does not claim to be the whole list when it is not. */
export function countLabel(n: number, one: string, many: string, { more, capped, filtered }: { more: boolean; capped: boolean; filtered: boolean }): string {
  const noun = n === 1 ? one : many;
  if (capped) return `Newest ${n.toLocaleString()} ${noun}${filtered ? " matching" : ""} — filter to find older ones`;
  return `${n.toLocaleString()}${more ? "+" : ""} ${filtered ? `${noun} matching` : noun}`;
}

/**
 * The end of a paged list. Coming into view asks for the next page, as a
 * virtualised list reaching its last rows would; the button is there for a
 * keyboard, and for a view that cannot observe scrolling.
 */
function LoadMore({ onMore, loading }: { onMore: () => void; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && onMore(), { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onMore]);
  return (
    <div ref={ref} className="flex justify-center py-2">
      <button type="button" onClick={onMore} disabled={loading} className="h-7 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-60">
        {loading ? "Loading…" : "Show more"}
      </button>
    </div>
  );
}

function BookmarkRow({
  item: b,
  onOpen,
  onRemove,
  onRename,
}: {
  item: Bookmark;
  onOpen: (e: React.MouseEvent, url: string) => void;
  onRemove: (bookmark: Bookmark) => void;
  onRename: (bookmark: Bookmark, title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return <RenameField bookmark={b} onDone={() => setEditing(false)} onRename={onRename} />;
  return (
    <div className="group flex items-center gap-1">
      <button type="button" title={libraryRowTitle(titleOf(b), b.url)} onClick={(e) => onOpen(e, b.url)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
        <Favicon src={b.favicon} size={14} fallback={Star} fallbackClassName="text-highlight" />
        <span className="truncate text-ink">{titleOf(b)}</span>
        <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(b.url)}</span>
      </button>
      <button
        type="button"
        aria-label={`Rename bookmark ${titleOf(b)}`}
        title="Rename"
        onClick={() => setEditing(true)}
        className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Pencil} size={13} />
      </button>
      <button
        type="button"
        aria-label={`Remove bookmark ${titleOf(b)}`}
        title="Remove bookmark"
        onClick={() => onRemove(b)}
        className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Trash2} size={13} />
      </button>
    </div>
  );
}

/** A bookmark's title, edited in place: Enter saves, Escape puts it back. */
function RenameField({ bookmark, onDone, onRename }: { bookmark: Bookmark; onDone: () => void; onRename: (bookmark: Bookmark, title: string) => Promise<void> }) {
  const [title, setTitle] = useState(titleOf(bookmark));
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.focus();
    node.select();
    // The Library's focus trap closes the whole dialog on Escape, and it
    // listens on the dialog itself -- before React hands the key to this
    // field. Stopped here, natively, Escape only ends the rename.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      done.current();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, []);
  const save = async () => {
    const next = title.trim();
    if (!next || next === titleOf(bookmark)) {
      onDone();
      return;
    }
    setBusy(true);
    try {
      await onRename(bookmark, next);
      onDone();
    } catch (e) {
      useBrowser.setState({ error: errorMessage(e) });
      setBusy(false);
    }
  };
  return (
    <form
      className="flex h-9 items-center gap-2 px-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Favicon src={bookmark.favicon} size={14} fallback={Star} fallbackClassName="text-highlight" />
      <input
        ref={field}
        aria-label={`New name for ${titleOf(bookmark)}`}
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => !busy && void save()}
        spellCheck={false}
        className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 text-xs text-ink outline-none select-text focus:border-highlight/60"
      />
    </form>
  );
}

function Bookmarks({ query, onOpened, scrollRef }: { query: string; onOpened: () => void; scrollRef?: React.RefObject<HTMLDivElement | null> }) {
  const { items, setItems, loadError, loading, retry, more, loadMore, capped, filtered } = usePagedSearch(ipc.bookmarksSearch, query);
  const localScrollRef = useRef<HTMLDivElement>(null);
  const targetScrollRef = scrollRef ?? localScrollRef;
  const open = useOpenRow(onOpened);
  const shown = items ?? [];
  const changed = () => window.dispatchEvent(new CustomEvent(BOOKMARKS_CHANGED));
  // The row goes at once, and the toast offers it back: a stray click on the
  // bin should not cost a bookmark kept for years.
  const remove = (bookmark: Bookmark) => {
    const prev = items;
    setItems((list) => (list ?? []).filter((b) => b.url !== bookmark.url));
    void ipc
      .bookmarkRemove(bookmark.url)
      .then(() => {
        changed();
        useBrowser.getState().notify(`Removed ${titleOf(bookmark)}`, 8000, {
          label: "Undo",
          run: () => {
            void ipc
              .bookmarkRestore(bookmark.url, bookmark.title, bookmark.created_at)
              .then(() => {
                setItems((list) => {
                  const rest = (list ?? []).filter((b) => b.url !== bookmark.url);
                  return [...rest, bookmark].sort((a, b) => b.created_at.localeCompare(a.created_at));
                });
                changed();
              })
              .catch((err: unknown) => useBrowser.setState({ error: errorMessage(err) }));
          },
        });
      })
      .catch((err) => {
        setItems(prev);
        useBrowser.setState({ error: errorMessage(err) });
      });
  };
  const rename = async (bookmark: Bookmark, title: string) => {
    await renameBookmark(bookmark.url, title);
    setItems((list) => (list ?? []).map((b) => (b.url === bookmark.url ? { ...b, title } : b)));
    changed();
  };

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => targetScrollRef.current,
    estimateSize: () => 36,
    overscan: 10,
    getItemKey: (i) => shown[i]?.url ?? i,
  });

  if (items === null && loadError) return <LoadFailed what="bookmarks" error={loadError} onRetry={retry} />;
  if (items === null) return <p className="p-3 text-xs text-ink-3">Loading…</p>;
  const header = <p className="px-2.5 pt-1 pb-2 text-[11px] text-ink-3" role="status">{countLabel(items.length, "bookmark", "bookmarks", { more, capped, filtered })}</p>;
  if (shown.length === 0) return !filtered ? <EmptyState icon={Star} title="No bookmarks yet" hint={`Press ${displayChord("⌘D")} on a page to keep it here`} /> : <NoMatch />;

  const virtualItems = virtualizer.getVirtualItems();
  const useVirtual = virtualItems.length > 0 && shown.length > 40;
  const footer = more && <LoadMore onMore={loadMore} loading={loading} />;

  if (!useVirtual) {
    return (
      <>
        {header}
        <ul className="flex flex-col">
          {shown.map((b) => (
            <li key={b.url}>
              <BookmarkRow item={b} onOpen={open} onRemove={remove} onRename={rename} />
            </li>
          ))}
        </ul>
        {footer}
      </>
    );
  }

  const virtualList = (
    <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
      {virtualItems.map((virtualRow) => {
        const b = shown[virtualRow.index];
        if (!b) return null;
        return (
          <div
            key={b.url}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <BookmarkRow item={b} onOpen={open} onRemove={remove} onRename={rename} />
          </div>
        );
      })}
    </div>
  );

  if (scrollRef) {
    return (
      <>
        {header}
        {virtualList}
        {footer}
      </>
    );
  }

  return (
    <div ref={localScrollRef} className="h-full overflow-y-auto">
      {header}
      {virtualList}
      {footer}
    </div>
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

/** The time of day a page was last visited, as the row shows it ("4:21 PM"); empty for an unreadable time. */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
  const { items, setItems, loadError, loading, retry, more, loadMore, capped, filtered } = usePagedSearch(ipc.historySearch, query);
  const openSettings = useBrowser((s) => s.openSettings);
  const open = useOpenRow(onOpened);
  // The row goes at once; a failed removal brings it back and says why --
  // a row that silently reappears looks like a click that missed.
  const remove = async (url: string) => {
    const before = items;
    setItems((list) => (list ?? []).filter((h) => h.url !== url));
    try {
      await ipc.historyRemove(url);
    } catch (e) {
      setItems(before);
      useBrowser.setState({ error: errorMessage(e) });
    }
  };
  const groups = useMemo(() => groupByDay(items ?? []), [items]);
  return (
    <>
      <div className="flex items-center justify-between px-2.5 pt-1 pb-2">
        <span className="text-[11px] text-ink-3" role="status">{items === null ? (loadError ? "" : "Loading…") : countLabel(items.length, "page", "pages", { more, capped, filtered })}</span>
        <button
          type="button"
          onClick={() => {
            onOpened();
            openSettings("privacy", "clear-browsing-data");
          }}
          className="h-7 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink"
        >
          Clear browsing data…
        </button>
      </div>
      {items === null && loadError && <LoadFailed what="history" error={loadError} onRetry={retry} />}
      {items !== null && groups.length === 0 && (!filtered ? <EmptyState icon={History} title="No history yet" hint="Pages you visit show up here" /> : <NoMatch />)}
      {groups.map((g) => (
        <section key={g.day} aria-label={g.day} className="mb-2">
          <h4 className="px-2.5 py-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{g.day}</h4>
          <ul className="flex flex-col">
            {g.entries.map((h) => (
              <li key={h.url} className="group flex items-center gap-1">
                <button type="button" title={libraryRowTitle(titleOf(h), h.url)} onClick={(e) => open(e, h.url)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
                  <Favicon src={h.favicon} size={14} fallback={History} />
                  <span className="truncate text-ink">{titleOf(h)}</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(h.url)}</span>
                  <span className="w-16 shrink-0 text-right font-mono text-[10.5px] text-ink-3 tabular-nums" aria-label={`at ${timeLabel(h.last_visited_at)}`}>
                    {timeLabel(h.last_visited_at)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${titleOf(h)} from history`}
                  title="Remove from history"
                  onClick={() => void remove(h.url)}
                  className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                >
                  <Icon icon={Trash2} size={13} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more && <LoadMore onMore={loadMore} loading={loading} />}
    </>
  );
}

/** The filter left nothing to show. */
function NoMatch() {
  return <EmptyState icon={Search} title="Nothing matches" hint="Try a shorter filter" />;
}

/**
 * A list that could not be read. It used to show the empty state ("No
 * bookmarks yet"), which told someone with a thousand bookmarks they had
 * none; this says what happened and offers to ask again.
 */
function LoadFailed({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <EmptyState icon={AlertTriangle} title={`Could not load ${what}`} hint={error} action={{ label: "Retry", onClick: onRetry }} />
    </div>
  );
}

/** One row of the Library's downloads: this session's live ones, and the kept ones from before. */
export interface LibraryDownload extends LiveDownload {
  /** The kept row's id, for taking it off the list. */
  recordId?: string;
}

/** A kept download as a row. */
export function fromRecord(record: DownloadRecord): LibraryDownload {
  const started = Date.parse(record.started_at);
  const updated = Date.parse(record.updated_at);
  return {
    recordId: record.id,
    url: record.url,
    path: record.path,
    name: fileNameOr(record.path, record.url),
    status: downloadStatus(record.status),
    at: Number.isNaN(updated) ? 0 : updated,
    startedAt: Number.isNaN(started) ? 0 : started,
    ...(record.bytes === null ? {} : { total: record.bytes }),
  };
}

/**
 * This session's downloads over the kept ones, newest first. The live row
 * wins for the same file: it has the progress, the engine id for Cancel,
 * and the latest state. A kept row "started" with no live one behind it was
 * cut off when Dive last quit, and says so.
 */
export function mergeDownloads(live: LiveDownload[], kept: DownloadRecord[]): LibraryDownload[] {
  const livePaths = new Set(live.filter((d) => d.path).map((d) => d.path));
  const liveFailures = new Set(live.filter((d) => !d.path).map((d) => `${d.url}\n${d.status}`));
  const older = kept
    .map(fromRecord)
    .filter((d) => (d.path ? !livePaths.has(d.path) : !liveFailures.has(`${d.url}\n${d.status}`)))
    .map((d) => (d.status === "started" ? { ...d, status: "failed" as const } : d));
  return [...live, ...older].sort((a, b) => b.startedAt - a.startedAt);
}

/** Every download this profile kept, with a way to the file, to stop one, or to try again. */
function DownloadsList({ query, onOpened }: { query: string; onOpened: () => void }) {
  const live = useDownloads((s) => s.items);
  const openTab = useBrowser((s) => s.openTab);
  const activeTab = useBrowser((s) => s.activeTab);
  const [kept, setKept] = useState<DownloadRecord[]>([]);
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    ipc
      .downloadsHistory(500)
      .then((rows) => alive && setKept(rows))
      .catch((e: unknown) => alive && useBrowser.setState({ error: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [attempt]);
  const items = useMemo(() => mergeDownloads(live, kept), [live, kept]);
  // Asked once per set of saved files, off the main thread: a file that was
  // moved or deleted says so instead of offering to open nothing.
  const savedPaths = useMemo(() => items.filter((d) => d.status === "finished" && d.path).map((d) => d.path), [items]);
  const savedKey = savedPaths.join("\n");
  useEffect(() => {
    if (!savedKey) return;
    let alive = true;
    ipc
      .downloadsMissing(savedKey.split("\n"))
      .then((gone) => alive && setMissing(new Set(gone)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [savedKey]);
  const shown = items.filter((d) => matches(query, d.name, d.url));
  const fail = (err: unknown) => useBrowser.setState({ error: errorMessage(err) });
  const reveal = (path: string | null) => void ipc.downloadsReveal(path).catch(fail);
  // A row opens its file, as a row in the downloads menu does; showing it in
  // the file manager is the folder button's job. A PDF opens in a tab, the
  // rest in the system's app. Only a saved file that is still there has
  // anything to open, and that is checked first rather than assumed.
  const openFile = async (path: string) => {
    try {
      const gone = await ipc.downloadsMissing([path]);
      if (gone.length > 0) {
        setMissing((prev) => new Set([...prev, path]));
        useBrowser.getState().notify("That file was moved or deleted.", 4000);
        return;
      }
      if (opensInTab(path)) {
        onOpened();
        void openTab(fileUrl(path));
        return;
      }
      await ipc.downloadsOpen(path);
    } catch (err) {
      fail(err);
    }
  };
  const retry = (url: string) => {
    if (!activeTab) {
      useBrowser.setState({ error: "Open a tab to download it again from." });
      return;
    }
    void ipc.downloadStart(activeTab, url).catch(fail);
  };
  const forget = (d: LibraryDownload) => {
    if (!d.recordId) return;
    setKept((rows) => rows.filter((r) => r.id !== d.recordId));
    void ipc.downloadForget(d.recordId).catch((err: unknown) => {
      fail(err);
      setAttempt((n) => n + 1);
    });
  };
  const clearAll = () => {
    setKept([]);
    useDownloads.setState((s) => ({ items: s.items.filter((d) => d.status === "started") }));
    void Promise.all([ipc.downloadsHistoryClear(), ipc.downloadsClear()]).catch((err: unknown) => {
      fail(err);
      setAttempt((n) => n + 1);
    });
  };
  const header = (
    <div className="flex items-center justify-between gap-2 px-2.5 pt-1 pb-2">
      <span className="text-[11px] text-ink-3">{`${items.length} ${items.length === 1 ? "download" : "downloads"}`}</span>
      {items.some((d) => d.status !== "started") && (
        <button type="button" onClick={clearAll} className="h-7 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
          Clear list
        </button>
      )}
    </div>
  );
  if (shown.length === 0) return items.length === 0 ? <EmptyState icon={Download} title="Nothing downloaded yet" hint="Files you save show up here" /> : <NoMatch />;
  const quiet = "grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100";
  return (
    <>
      {header}
      <ul className="flex flex-col">
        {shown.map((d) => {
          const gone = d.status === "finished" && missing.has(d.path);
          const saved = d.status === "finished" && Boolean(d.path) && !gone;
          const running = d.status === "started";
          const again = (d.status === "failed" || d.status === "cancelled" || gone) && /^https?:/i.test(d.url);
          const label = gone ? "Moved or deleted" : downloadStatusLabel(d.status);
          return (
            <li key={d.recordId ?? `${d.path || d.url}-${d.startedAt}`} className="group flex items-center gap-1">
              <button type="button" title={d.name} disabled={!saved} onClick={() => void openFile(d.path)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs enabled:hover:bg-surface-2">
                <Icon icon={Download} size={14} className="shrink-0 text-ink-3" />
                <span className={`truncate ${gone ? "text-ink-3 line-through" : "text-ink"}`}>{d.name}</span>
                <span className={`ml-auto shrink-0 pl-3 text-[11px] ${d.status === "failed" ? "text-danger" : "text-ink-3"}`}>{label}</span>
              </button>
              {running && d.id !== undefined && (
                <button type="button" aria-label={`Cancel ${d.name}`} title="Cancel" onClick={() => void ipc.downloadsCancel(d.id as number).catch(fail)} className={quiet}>
                  <Icon icon={X} size={13} />
                </button>
              )}
              {again && (
                <button type="button" aria-label={`Download ${d.name} again`} title="Download again" onClick={() => retry(d.url)} className={quiet}>
                  <Icon icon={RotateCw} size={13} />
                </button>
              )}
              {saved && (
                <button type="button" aria-label={`Show ${d.name} in ${fileManagerName()}`} title={`Show in ${fileManagerName()}`} onClick={() => reveal(d.path)} className={quiet}>
                  <Icon icon={FolderOpen} size={13} />
                </button>
              )}
              {!running && d.recordId && (
                <button type="button" aria-label={`Remove ${d.name} from the list`} title="Remove from list (the file stays)" onClick={() => forget(d)} className={quiet}>
                  <Icon icon={Trash2} size={13} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Every recording on disk: open it, find it, or edit it in DiveScreen. */
function Recordings({ query, onOpened }: { query: string; onOpened: () => void }) {
  const [items, setItems] = useState<RecordingInfo[] | null>(null);
  // The row whose Delete was pressed once; the file only goes on the second press.
  const [confirming, setConfirming] = useState<string | null>(null);
  const openTab = useBrowser((s) => s.openTab);
  const importing = useImportVideo((s) => s.busy);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    ipc
      .recordingsList()
      .then((r) => alive && (setItems(r), setLoadError(null)))
      .catch((e: unknown) => alive && setLoadError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [attempt]);
  const remove = (path: string) => {
    const prev = items;
    setConfirming(null);
    setItems((list) => (list ?? []).filter((r) => r.path !== path));
    void ipc
      .recordingDelete(path)
      .then(() => useBrowser.getState().notify("Recording deleted", 4000))
      .catch((err) => {
        setItems(prev);
        useBrowser.setState({ error: err instanceof Error ? err.message : String(err) });
      });
  };
  const reveal = (path: string) => {
    void ipc.downloadsReveal(path).catch((err) => {
      useBrowser.setState({ error: err instanceof Error ? err.message : String(err) });
    });
  };
  const openRecording = (path: string) => {
    void ipc.recordingOpen(path).catch((err) => {
      useBrowser.setState({ error: err instanceof Error ? err.message : String(err) });
    });
  };
  const shown = (items ?? []).filter((r) => matches(query, r.name, r.format));
  const header = (
    <div className="flex items-center justify-between gap-2 px-2.5 pt-1 pb-2">
      <span className="min-w-0 truncate text-[11px] text-ink-3">
        {importing ? IMPORT_BUSY : items === null ? (loadError ? "" : "Loading…") : `${items.length} ${items.length === 1 ? "recording" : "recordings"}`}
      </span>
      <OpenVideoButton onOpened={onOpened} className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-60" />
    </div>
  );
  if (items === null) {
    return (
      <>
        {header}
        {loadError && <LoadFailed what="recordings" error={loadError} onRetry={() => setAttempt((n) => n + 1)} />}
      </>
    );
  }
  if (shown.length === 0) {
    return (
      <>
        {header}
        {items.length === 0 ? <EmptyState icon={Clapperboard} title="No recordings yet" hint="Press Record in the title bar, or open a video file" /> : <NoMatch />}
      </>
    );
  }
  return (
    <>
    {header}
    <ul className="flex flex-col">
      {shown.map((r) => (
        <li key={r.path} className="group flex items-center gap-1">
          <button type="button" title={r.name} onClick={() => openRecording(r.path)} className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
            <Icon icon={Clapperboard} size={14} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">{r.name}</span>
              <span className="block truncate font-mono text-[10.5px] text-ink-3">
                {r.format.toUpperCase()} · {recordingBytes(r.bytes ?? 0)} · {new Date(r.modified_ms ?? 0).toLocaleString()}
                {r.has_project ? " · edited" : ""}
              </span>
            </span>
          </button>
          {confirming === r.path ? (
            <>
              <span className="shrink-0 text-[11px] text-ink-2">Delete this recording?</span>
              <button type="button" onClick={() => setConfirming(null)} className="h-7 shrink-0 rounded-full px-2.5 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
                Keep
              </button>
              <button type="button" aria-label={`Delete ${r.name} for good`} onClick={() => remove(r.path)} className="h-7 shrink-0 rounded-full bg-danger px-2.5 text-[11px] font-medium text-danger-ink hover:brightness-110">
                Delete
              </button>
            </>
          ) : (
            <>
              {r.editable && (
                <button
                  type="button"
                  aria-label={`Edit ${r.name} in DiveScreen`}
                  title="Edit in DiveScreen"
                  onClick={() => {
                    onOpened();
                    void openTab(screenUrl(r.path));
                  }}
                  className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-highlight"
                >
                  <Icon icon={Wand2} size={13} />
                </button>
              )}
              <button type="button" aria-label={`Show ${r.name} in ${fileManagerName()}`} title={`Show in ${fileManagerName()}`} onClick={() => reveal(r.path)} className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100">
                <Icon icon={FolderOpen} size={13} />
              </button>
              <button type="button" aria-label={`Delete ${r.name}`} title="Delete recording" onClick={() => setConfirming(r.path)} className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100">
                <Icon icon={Trash2} size={13} />
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
    </>
  );
}

/** Installed web apps: open one in its window, or take it back out. */
function Apps({ query, onOpened }: { query: string; onOpened: () => void }) {
  const apps = useWebApps((s) => s.apps);
  const loaded = useWebApps((s) => s.loaded);
  const load = useWebApps((s) => s.load);
  const open = useWebApps((s) => s.open);
  const uninstall = useWebApps((s) => s.uninstall);
  useEffect(() => {
    void load();
    window.addEventListener(WEBAPPS_CHANGED, load);
    return () => window.removeEventListener(WEBAPPS_CHANGED, load);
  }, [load]);
  const shown = apps.filter((app) => matches(query, app.name, app.start_url));
  if (!loaded) return null;
  if (shown.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-xs text-ink-3">
        {apps.length === 0 ? "No installed apps yet. Sites that offer one show an install button beside the address." : "Nothing matches."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map((app) => (
        <AppRow key={app.id} app={app} onOpen={() => { onOpened(); void open(app.id); }} onRemove={() => void uninstall(app.id)} />
      ))}
    </div>
  );
}

function AppRow({ app, onOpen, onRemove }: { app: WebApp; onOpen: () => void; onRemove: () => void }) {
  const icon = useWebAppIcon(app.id);
  return (
    <div className="group flex items-center gap-1">
      <button type="button" title={libraryRowTitle(app.name, app.start_url)} onClick={onOpen} className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
        {icon ? (
          <img src={icon} alt="" width={20} height={20} className="size-5 shrink-0 rounded-md" />
        ) : (
          <Icon icon={AppWindow} size={16} className="shrink-0 text-ink-3" />
        )}
        <span className="truncate text-ink">{app.name}</span>
        <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(app.start_url)}</span>
      </button>
      <button
        type="button"
        aria-label={`Uninstall ${app.name}`}
        title="Uninstall"
        onClick={onRemove}
        className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Trash2} size={13} />
      </button>
    </div>
  );
}
