import { Clapperboard, Download, FolderOpen, History, Search, Star, Trash2, Wand2, X } from "lucide-react";
import { BOOKMARKS_CHANGED } from "../lib/commands";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ipc } from "../lib/ipc";
import type { Bookmark, HistoryEntry, RecordingInfo } from "../lib/ipc";
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
import { Favicon } from "./Favicon";
import { Icon, IconButton } from "./Icon";

/** How many rows each list loads; the filter box narrows from there. */
export const LIBRARY_LIMIT = 200;

type LibraryTab = "bookmarks" | "history" | "downloads" | "recordings";
const TABS: { id: LibraryTab; label: string; icon: typeof Star }[] = [
  { id: "bookmarks", label: "Bookmarks", icon: Star },
  { id: "history", label: "History", icon: History },
  { id: "downloads", label: "Downloads", icon: Download },
  { id: "recordings", label: "Recordings", icon: Clapperboard },
];

/** Bookmarks and history in one dialog: ⌘Y. */
/** What a row is called: its title, or its address when the page never gave one (older rows may still say "about:blank"). */
export function titleOf(entry: { title: string; url: string }): string {
  return entry.title && entry.title !== "about:blank" ? entry.title : entry.url;
}

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
        <div role="tabpanel" id={`library-panel-${tab}`} aria-labelledby={`library-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto p-2">
          {tab === "bookmarks" ? <Bookmarks query={query} onOpened={close} /> : tab === "history" ? <HistoryList query={query} onOpened={close} /> : tab === "downloads" ? <DownloadsList query={query} /> : <Recordings query={query} onOpened={close} />}
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

function BookmarkRow({
  item: b,
  onOpen,
  onRemove,
}: {
  item: Bookmark;
  onOpen: (e: React.MouseEvent, url: string) => void;
  onRemove: (url: string) => void;
}) {
  return (
    <div className="group flex items-center gap-1">
      <button type="button" onClick={(e) => onOpen(e, b.url)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
        <Favicon src={b.favicon} size={14} fallback={Star} fallbackClassName="text-highlight" />
        <span className="truncate text-ink">{titleOf(b)}</span>
        <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(b.url)}</span>
      </button>
      <button
        type="button"
        aria-label={`Remove bookmark ${titleOf(b)}`}
        onClick={() => onRemove(b.url)}
        className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Trash2} size={13} />
      </button>
    </div>
  );
}

function Bookmarks({ query, onOpened }: { query: string; onOpened: () => void }) {
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const shown = useMemo(() => (items ?? []).filter((b) => matches(query, b.title, b.url)), [items, query]);
  const remove = (url: string) => {
    const prev = items;
    setItems((list) => (list ?? []).filter((b) => b.url !== url));
    void ipc
      .bookmarkRemove(url)
      .then(() => window.dispatchEvent(new CustomEvent(BOOKMARKS_CHANGED)))
      .catch((err) => {
        setItems(prev);
        useBrowser.setState({ error: err instanceof Error ? err.message : String(err) });
      });
  };

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 10,
    getItemKey: (i) => shown[i]?.url ?? i,
  });

  if (items === null) return <p className="p-3 text-xs text-ink-3">Loading…</p>;
  if (shown.length === 0) return items.length === 0 ? <EmptyState icon={Star} title="No bookmarks yet" hint="Press ⌘D on a page to keep it here" /> : <NoMatch />;

  const virtualItems = virtualizer.getVirtualItems();
  const useVirtual = virtualItems.length > 0 && shown.length > 40;

  if (!useVirtual) {
    return (
      <ul className="flex flex-col">
        {shown.map((b) => (
          <li key={b.url}>
            <BookmarkRow item={b} onOpen={open} onRemove={remove} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
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
              <BookmarkRow item={b} onOpen={open} onRemove={remove} />
            </div>
          );
        })}
      </div>
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
  // The row goes at once; a failed removal brings it back.
  const remove = async (url: string) => {
    const before = items;
    setItems((list) => (list ?? []).filter((h) => h.url !== url));
    try {
      await ipc.historyRemove(url);
    } catch {
      setItems(before);
    }
  };
  const groups = useMemo(() => groupByDay((items ?? []).filter((h) => matches(query, h.title, h.url))), [items, query]);
  return (
    <>
      <div className="flex items-center justify-between px-2.5 pt-1 pb-2">
        <span className="text-[11px] text-ink-3">{items === null ? "Loading…" : `${items.length} ${items.length === 1 ? "page" : "pages"}`}</span>
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
      {items !== null && groups.length === 0 && (items.length === 0 ? <EmptyState icon={History} title="No history yet" hint="Pages you visit show up here" /> : <NoMatch />)}
      {groups.map((g) => (
        <section key={g.day} aria-label={g.day} className="mb-2">
          <h4 className="px-2.5 py-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{g.day}</h4>
          <ul className="flex flex-col">
            {g.entries.map((h) => (
              <li key={h.url} className="group flex items-center gap-1">
                <button type="button" onClick={(e) => open(e, h.url)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
                  <Favicon src={h.favicon} size={14} fallback={History} />
                  <span className="truncate text-ink">{titleOf(h)}</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(h.url)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${titleOf(h)} from history`}
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
    </>
  );
}

/** The filter left nothing to show. */
function NoMatch() {
  return <EmptyState icon={Search} title="Nothing matches" hint="Try a shorter filter" />;
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** This session's downloads, newest first, with a way to the file. */
function DownloadsList({ query }: { query: string }) {
  const items = useDownloads((s) => s.items);
  const shown = items.filter((d) => matches(query, d.name, d.url));
  if (shown.length === 0) return items.length === 0 ? <EmptyState icon={Download} title="Nothing downloaded yet" hint="Files you save this session show up here" /> : <NoMatch />;
  const reveal = (path: string | null) => {
    void ipc.downloadsReveal(path).catch((err) => {
      useBrowser.setState({ error: err instanceof Error ? err.message : String(err) });
    });
  };
  return (
    <ul className="flex flex-col">
      {shown.map((d) => (
        <li key={`${d.url}-${d.at}`} className="group flex items-center gap-1">
          <button type="button" onClick={() => reveal(d.path)} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
            <Icon icon={Download} size={14} className="shrink-0 text-ink-3" />
            <span className="truncate text-ink">{d.name}</span>
            <span className="ml-auto shrink-0 pl-3 text-[11px] text-ink-3">{d.status}</span>
          </button>
          <button type="button" aria-label={`Show ${d.name} in Finder`} onClick={() => reveal(d.path)} className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100">
            <Icon icon={FolderOpen} size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Every recording on disk: open it, find it, or edit it in DiveScreen. */
function Recordings({ query, onOpened }: { query: string; onOpened: () => void }) {
  const [items, setItems] = useState<RecordingInfo[] | null>(null);
  // The row whose Delete was pressed once; the file only goes on the second press.
  const [confirming, setConfirming] = useState<string | null>(null);
  const openTab = useBrowser((s) => s.openTab);
  const importing = useImportVideo((s) => s.busy);
  useEffect(() => {
    let alive = true;
    ipc
      .recordingsList()
      .then((r) => alive && setItems(r))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);
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
        {importing ? IMPORT_BUSY : items === null ? "Loading…" : `${items.length} ${items.length === 1 ? "recording" : "recordings"}`}
      </span>
      <OpenVideoButton onOpened={onOpened} className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-60" />
    </div>
  );
  if (items === null) return header;
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
          <button type="button" onClick={() => openRecording(r.path)} className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-xs hover:bg-surface-2">
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
              <button type="button" aria-label={`Delete ${r.name} for good`} onClick={() => remove(r.path)} className="h-7 shrink-0 rounded-full bg-danger px-2.5 text-[11px] font-medium text-white hover:brightness-110">
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
              <button type="button" aria-label={`Show ${r.name} in Finder`} onClick={() => reveal(r.path)} className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100">
                <Icon icon={FolderOpen} size={13} />
              </button>
              <button type="button" aria-label={`Delete ${r.name}`} onClick={() => setConfirming(r.path)} className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-danger focus:opacity-100 group-hover:opacity-100">
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
