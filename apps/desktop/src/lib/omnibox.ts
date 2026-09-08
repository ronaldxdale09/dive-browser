import type { Bookmark, HistoryEntry, Tab } from "./ipc";

/** Most rows the address bar offers; past this the list hides the page for little gain. */
export const SUGGESTION_LIMIT = 8;

/** Delay before history and bookmarks are asked, so a burst of keystrokes costs one query. */
export const SUGGESTION_DEBOUNCE_MS = 120;

export type Suggestion =
  | { kind: "open" | "search"; url: string; title: string; favicon: null }
  | { kind: "tab"; url: string; title: string; favicon: string | null; tabId: string }
  | { kind: "bookmark" | "history"; url: string; title: string; favicon: string | null };

/**
 * Whether the backend will treat what was typed as an address rather than a
 * search. Mirrors `normalize_url_with` in the Rust side, which the address
 * bar's submit path always goes through: a parseable scheme, or a single token
 * with a dot or a loopback prefix.
 */
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/^(https?|file|about|data|blob|dive):/i.test(trimmed)) return true;
  if (/\s/.test(trimmed)) return false;
  return trimmed.includes(".") || trimmed.startsWith("localhost") || trimmed.startsWith("127.");
}

/**
 * Host of `url`, or the empty string for anything that is not one. Dive's
 * own pages have no host worth showing, so they keep their whole address
 * ("dive://capture", not "capture").
 */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : url;
  } catch {
    return "";
  }
}

/**
 * Where a row leads, as the list shows it: host and path without scheme,
 * query or a trailing slash ("localhost:8771/form.html"), so two pages on
 * one site can be told apart. Dive's own pages keep their whole address.
 */
export function placeOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return parsed.host + path;
  } catch {
    return "";
  }
}

/**
 * A row's name: its title, or its address when the title is empty or the
 * blank document's own name, which older history recorded before the page
 * had a title of its own.
 */
export function titleOf(entry: { title: string; url: string }): string {
  return entry.title && entry.title !== "about:blank" ? entry.title : entry.url;
}

/**
 * Whether typing `needle` is the start of the site `url` lives on, the way a
 * person types "gith" meaning github.com. Only the host counts, with or
 * without "www.", so a match in a path or a title does not qualify.
 */
export function leadsTo(needle: string, url: string): boolean {
  const host = hostOf(url).toLowerCase();
  if (!host || host === url) return false;
  return host.startsWith(needle) || host.replace(/^www\./, "").startsWith(needle);
}

function matches(query: string, ...fields: (string | null | undefined)[]) {
  return fields.some((field) => field?.toLowerCase().includes(query));
}

/**
 * The rows under the address bar for `query`, in the order they are offered:
 * the literal open-or-search row, then open tabs, bookmarks and history. A URL
 * appears once, wherever it is first seen -- a page that is open is offered as
 * a tab rather than again from history.
 */
export function buildSuggestions(
  query: string,
  { tabs, bookmarks, history }: { tabs: readonly Tab[]; bookmarks: readonly Bookmark[]; history: readonly HistoryEntry[] },
  limit = SUGGESTION_LIMIT,
): Suggestion[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const needle = trimmed.toLowerCase();
  const rows: Suggestion[] = [{ kind: looksLikeUrl(trimmed) ? "open" : "search", url: trimmed, title: trimmed, favicon: null }];
  const seen = new Set<string>();
  const add = (row: Suggestion) => {
    if (rows.length >= limit || seen.has(row.url)) return;
    seen.add(row.url);
    rows.push(row);
  };
  for (const tab of tabs) {
    if (matches(needle, tab.title, tab.url)) add({ kind: "tab", url: tab.url, title: titleOf(tab), favicon: tab.favicon, tabId: tab.id });
  }
  for (const bookmark of bookmarks) {
    if (matches(needle, bookmark.title, bookmark.url)) add({ kind: "bookmark", url: bookmark.url, title: titleOf(bookmark), favicon: bookmark.favicon });
  }
  for (const entry of history) {
    if (matches(needle, entry.title, entry.url)) add({ kind: "history", url: entry.url, title: titleOf(entry), favicon: entry.favicon });
  }
  // A few letters that begin a known site lead there on Enter, not to a web
  // search for those letters: "exam" with example.com open goes to the tab.
  // An address typed out in full keeps the literal row first, so Enter loads
  // it afresh even when a tab already shows it.
  if (!looksLikeUrl(trimmed)) {
    const site = rows.findIndex((row, index) => index > 0 && leadsTo(needle, row.url));
    if (site > 0) rows.unshift(...rows.splice(site, 1));
  }
  return rows.slice(0, limit);
}

/** Next highlight after an arrow key, wrapping at both ends. */
export function stepHighlight(current: number, count: number, delta: 1 | -1): number {
  if (count === 0) return 0;
  return (current + delta + count) % count;
}
