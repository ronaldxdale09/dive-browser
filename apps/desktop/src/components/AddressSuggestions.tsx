import { ArrowUpRight, History, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Bookmark, HistoryEntry, Tab } from "../lib/ipc";
import { SUGGESTION_DEBOUNCE_MS, SUGGESTION_LIMIT, buildSuggestions, inlineCompletion, looksLikeUrl, placeOf, searchWords, stepHighlight, suggestionKey } from "../lib/omnibox";
import type { Suggestion } from "../lib/omnibox";
import { errorMessage } from "../lib/errors";
import { useCoversContent } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { Favicon } from "./Favicon";
import { Icon } from "./Icon";

/** How long the list's length must hold before it is announced, so a burst of typing is one announcement. */
const ANNOUNCE_DELAY_MS = 400;

/**
 * Rows for the address bar while `query` is being typed. Tabs are matched
 * locally; bookmarks and history come from the store after a short debounce.
 *
 * The highlight follows a row, not a position: history arriving a moment
 * after the tabs rebuilds the list, and a highlight kept by index then sat on
 * whatever row had moved under it, so Enter opened something else. Once the
 * arrow keys are used the order is also held still for that query, so the row
 * being walked towards does not jump away. With nothing chosen the highlight
 * is on the first row, so Enter means "the row you can see at the top".
 *
 * With `autocomplete`, the first site whose address begins with what was
 * typed is completed in place (`completion`) and leads the list.
 */
export function useAddressSuggestions(
  query: string,
  active: boolean,
  tabs: readonly Tab[],
  { activeTab = null, autocomplete = false }: { activeTab?: string | null; autocomplete?: boolean } = {},
) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const trimmed = active ? query.trim() : "";
  const words = searchWords(trimmed);
  const forced = trimmed.startsWith("?");
  // Results from the last query stay around until the next answer; they are
  // re-filtered against the new text, so nothing stale shows meanwhile.
  useEffect(() => {
    if (!words) return;
    let alive = true;
    const timer = setTimeout(() => {
      // A forced search offers no pages, so there is nothing to look up.
      if (!forced) {
        ipc
          .bookmarksSearch(words, SUGGESTION_LIMIT)
          .then((found) => alive && setBookmarks(found))
          .catch(() => alive && setBookmarks([]));
        ipc
          .historySearch(words, SUGGESTION_LIMIT)
          .then((found) => alive && setHistory(found))
          .catch(() => alive && setHistory([]));
      }
      // The engine is asked only for what could be a search. An address being
      // typed out is nobody else's business.
      if (looksLikeUrl(trimmed)) setSuggestions([]);
      else
        ipc
          .searchSuggest(words)
          .then((found) => alive && setSuggestions(found))
          .catch(() => alive && setSuggestions([]));
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trimmed, words, forced]);
  const live = useMemo(() => buildSuggestions(trimmed, { tabs, bookmarks, history, suggestions, activeTab }), [trimmed, tabs, bookmarks, history, suggestions, activeTab]);
  const [frozen, setFrozen] = useState<{ query: string; rows: Suggestion[] } | null>(null);
  // A held order belongs to one query; typing lets the list follow again.
  if (frozen !== null && frozen.query !== trimmed) setFrozen(null);
  const held = frozen !== null && frozen.query === trimmed ? frozen.rows : null;
  const completion = !held && autocomplete && active ? inlineCompletion(query, live) : null;
  const rows = held ?? (completion ? [live[completion.index]!, ...live.filter((_, index) => index !== completion.index)] : live);
  const [pointed, setPointed] = useState<{ query: string; key: string | null }>({ query: trimmed, key: null });
  const key = pointed.query === trimmed ? pointed.key : null;
  const highlight = Math.max(key === null ? -1 : rows.findIndex((row) => suggestionKey(row) === key), 0);
  const point = (row: Suggestion | undefined) => setPointed({ query: trimmed, key: row ? suggestionKey(row) : null });
  const setHighlight = (index: number) => point(rows[index]);
  const move = (delta: 1 | -1) => {
    if (!held) setFrozen({ query: trimmed, rows });
    point(rows[stepHighlight(highlight, rows.length, delta)]);
  };
  // Shift+Delete on a visited page forgets it, here and in history, and the
  // highlight moves on to the row that takes its place.
  const remove = (row: Suggestion) => {
    if (row.kind !== "history") return false;
    const index = rows.indexOf(row);
    point(rows[index + 1] ?? rows[index - 1]);
    setHistory((entries) => entries.filter((entry) => entry.url !== row.url));
    if (held) setFrozen({ query: trimmed, rows: held.filter((candidate) => candidate !== row) });
    ipc.historyRemove(row.url).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
    return true;
  };
  return { rows, highlight, setHighlight, move, remove, completion: completion?.text ?? null };
}

/** Hover name for a clipped row: the page, and its place when that is different. */
export function suggestionHoverTitle(row: Suggestion): string {
  if (row.kind === "open" || row.kind === "search" || row.kind === "suggest") return row.title;
  const name = row.title || row.url;
  const place = placeOf(row.url);
  return place && place !== name ? `${name} — ${place}` : name;
}

/** Rows and icons that say what the row does. */
function rowGlyph(row: Suggestion) {
  switch (row.kind) {
    case "open":
      return <Icon icon={ArrowUpRight} size={14} className="shrink-0 text-ink-3" />;
    case "search":
    case "suggest":
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
  // A screen reader follows the highlighted row but is never told the list
  // appeared or how long it is; the count is said once typing pauses. The
  // region stays mounted, as one that appears with its text is not read.
  const count = open ? `${rows.length} ${rows.length === 1 ? "suggestion" : "suggestions"}` : "";
  const [said, setSaid] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSaid(count), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [count]);
  const status = (
    <span role="status" aria-live="polite" className="sr-only">
      {said}
    </span>
  );
  if (!open) return status;
  return (
    <>
    {status}
    <ul
      id={id}
      role="listbox"
      aria-label="Address suggestions"
      onMouseDown={(event) => event.preventDefault()}
      className="surface-enter absolute inset-x-0 top-full z-50 mt-1 rounded-xl border border-line-2 bg-surface p-1 text-xs shadow-2xl"
    >
      {rows.map((row, index) => (
        <li
          key={suggestionKey(row)}
          id={optionId(id, index)}
          role="option"
          aria-selected={index === highlight}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onPick(row)}
          title={suggestionHoverTitle(row)}
          className={`flex h-8 cursor-default items-center gap-2 rounded-lg px-2.5 ${index === highlight ? "bg-surface-2 text-ink" : "text-ink"}`}
        >
          {rowGlyph(row)}
          {row.kind === "open" || row.kind === "search" || row.kind === "suggest" ? (
            <>
              <span className="text-ink-2">{row.kind === "open" ? "Open" : "Search"}</span>
              <span className={`truncate ${row.kind === "suggest" ? "" : "font-mono"}`}>{row.title}</span>
            </>
          ) : (
            <>
              <span className="truncate">{row.title || row.url}</span>
              {row.kind === "tab" && <span className="shrink-0 rounded-full border border-line px-1.5 text-[10px] leading-4 text-ink-3">Switch to tab</span>}
              <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{placeOf(row.url)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
    </>
  );
}

/** DOM id of the row at `index`, for `aria-activedescendant`. */
export function optionId(listId: string, index: number) {
  return `${listId}-${index}`;
}
