import { ArrowUpRight, History, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Bookmark, HistoryEntry, Tab } from "../lib/ipc";
import { SUGGESTION_DEBOUNCE_MS, SUGGESTION_LIMIT, buildSuggestions, hostOf, stepHighlight } from "../lib/omnibox";
import type { Suggestion } from "../lib/omnibox";
import { useCoversContent } from "../lib/overlay";
import { Favicon } from "./Favicon";
import { Icon } from "./Icon";

/**
 * Rows for the address bar while `query` is being typed. Tabs are matched
 * locally; bookmarks and history come from the store after a short debounce.
 * The highlight starts on the first row and is reset whenever the query
 * changes, so Enter always means "the row you can see at the top" unless the
 * arrow keys said otherwise.
 */
export function useAddressSuggestions(query: string, active: boolean, tabs: readonly Tab[]) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const trimmed = active ? query.trim() : "";
  // Results from the last query stay around until the next answer; they are
  // re-filtered against the new text, so nothing stale shows meanwhile.
  useEffect(() => {
    if (!trimmed) return;
    let alive = true;
    const timer = setTimeout(() => {
      ipc
        .bookmarksSearch(trimmed, SUGGESTION_LIMIT)
        .then((found) => alive && setBookmarks(found))
        .catch(() => alive && setBookmarks([]));
      ipc
        .historySearch(trimmed, SUGGESTION_LIMIT)
        .then((found) => alive && setHistory(found))
        .catch(() => alive && setHistory([]));
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trimmed]);
  const rows = useMemo(() => buildSuggestions(trimmed, { tabs, bookmarks, history }), [trimmed, tabs, bookmarks, history]);
  const [highlightState, setHighlightState] = useState({ query: trimmed, index: 0 });
  const highlight = highlightState.query === trimmed ? Math.min(highlightState.index, Math.max(rows.length - 1, 0)) : 0;
  const setHighlight = (index: number) => setHighlightState({ query: trimmed, index });
  const move = (delta: 1 | -1) => setHighlight(stepHighlight(highlight, rows.length, delta));
  return { rows, highlight, setHighlight, move };
}

/** Rows and icons that say what the row does. */
function rowGlyph(row: Suggestion) {
  switch (row.kind) {
    case "open":
      return <Icon icon={ArrowUpRight} size={14} className="shrink-0 text-ink-3" />;
    case "search":
      return <Icon icon={Search} size={14} className="shrink-0 text-ink-3" />;
    case "bookmark":
      return <Favicon src={row.favicon} size={14} fallback={Star} fallbackClassName="text-highlight" />;
    case "history":
      return <Favicon src={row.favicon} size={14} fallback={History} />;
    case "tab":
      return <Favicon src={row.favicon} size={14} />;
  }
}

/**
 * The dropdown under the address bar. It is a listbox driven from the input
 * -- the input keeps focus and names the highlighted row through
 * `aria-activedescendant` -- so pressing on a row must not move focus, and
 * the page underneath is hidden for as long as the list is on screen.
 */
export function AddressSuggestions({
  id,
  rows,
  highlight,
  onHighlight,
  onPick,
}: {
  id: string;
  rows: readonly Suggestion[];
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (row: Suggestion) => void;
}) {
  const open = rows.length > 0;
  useCoversContent(open);
  if (!open) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Address suggestions"
      onMouseDown={(event) => event.preventDefault()}
      className="surface-enter absolute inset-x-0 top-full z-50 mt-1 rounded-xl border border-line-2 bg-surface p-1.5 text-xs shadow-2xl"
    >
      {rows.map((row, index) => (
        <li
          key={`${row.kind}|${row.url}`}
          id={optionId(id, index)}
          role="option"
          aria-selected={index === highlight}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onPick(row)}
          className={`flex cursor-default items-center gap-2 rounded-lg px-3 py-2 ${index === highlight ? "bg-surface-2 text-ink" : "text-ink"}`}
        >
          {rowGlyph(row)}
          {row.kind === "open" || row.kind === "search" ? (
            <>
              <span className="text-ink-2">{row.kind === "open" ? "Open" : "Search"}</span>
              <span className="truncate font-mono">{row.title}</span>
            </>
          ) : (
            <>
              <span className="truncate">{row.title || row.url}</span>
              {row.kind === "tab" && <span className="shrink-0 rounded-full border border-line px-1.5 text-[10px] leading-4 text-ink-3">Switch to tab</span>}
              <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{hostOf(row.url)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** DOM id of the row at `index`, for `aria-activedescendant`. */
export function optionId(listId: string, index: number) {
  return `${listId}-${index}`;
}
