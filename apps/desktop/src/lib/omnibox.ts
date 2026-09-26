import type { Bookmark, HistoryEntry, Tab } from "./ipc";
import tldList from "../../src-tauri/src/omnibox/tlds.txt?raw";

/** Most rows the address bar offers; past this the list hides the page for little gain. */
export const SUGGESTION_LIMIT = 8;

/** Delay before history and bookmarks are asked, so a burst of keystrokes costs one query. */
export const SUGGESTION_DEBOUNCE_MS = 120;

export type Suggestion =
  | { kind: "open" | "search" | "suggest"; url: string; title: string; favicon: null }
  | { kind: "tab"; url: string; title: string; favicon: string | null; tabId: string }
  | { kind: "bookmark" | "history"; url: string; title: string; favicon: string | null };

/** Schemes the engine loads itself when they are typed out in full. */
const ADDRESS_SCHEMES = new Set(["http", "https", "file", "about", "data", "blob", "view-source", "dive"]);

/**
 * Schemes the engine speaks (`INTERNAL` in external_link.rs). Any other
 * scheme typed out is another app's link, passed on so the "open in another
 * app" question is asked.
 */
const ENGINE_SCHEMES = new Set(["http", "https", "about", "blob", "data", "file", "javascript", "devtools", "chrome", "chrome-error", "chrome-extension", "chrome-untrusted", "view-source", "ws", "wss", "dive"]);

/** The top-level domains a bare name must end in, from the list the backend reads too. */
const TLDS = new Set(
  tldList
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .flatMap((line) => line.split(/\s+/))
    .filter(Boolean),
);

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const LABEL = /^(?:[a-z0-9_-]|[^\p{ASCII}])+$/iu;

/**
 * Whether the backend will treat what was typed as an address rather than a
 * search. Mirrors `omnibox::classify` on the Rust side, which the address
 * bar's submit path always goes through; both are tested against the same
 * examples (src-tauri/src/omnibox/vectors.json), so a rule changed in one
 * has to change in the other.
 */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim();
  if (!text || text.startsWith("?")) return false;
  if (text.startsWith("/") || text === "~" || text.startsWith("~/")) return true;
  if (/^[a-z]:[\\/]/i.test(text) && typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent)) return true;
  return withScheme(text) || bareHost(text);
}

/** An address typed with a scheme the engine loads, or another app's link. */
function withScheme(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  if (ADDRESS_SCHEMES.has(scheme)) return true;
  const rest = text.slice(text.indexOf(":") + 1);
  // "localhost:3000" parses as a scheme and a path; it is a host and a port.
  const portLike = /^\d+(?:[/?#]|$)/.test(rest);
  return scheme.length > 1 && !portLike && rest !== "" && !rest.startsWith(":") && !/\s/.test(text) && !ENGINE_SCHEMES.has(scheme);
}

/** A host typed without a scheme: an IP, this machine, a name with a port, or a name ending in a known domain. */
function bareHost(text: string): boolean {
  if (/\s/.test(text)) return false;
  const end = text.search(/[/?#]/);
  const split = splitPort(end === -1 ? text : text.slice(0, end));
  if (!split) return false;
  const { host, port } = split;
  if (host.startsWith("[")) return host.endsWith("]") && URL.canParse(`http://${host}`);
  if (IPV4.test(host)) return true;
  const labels = host.replace(/\.$/, "").toLowerCase().split(".");
  if (labels.some((label) => !LABEL.test(label))) return false;
  const tld = labels[labels.length - 1]!;
  // A single word is a search unless it is this machine or names a port:
  // "myserver:8080" is somebody's intranet, "12:30" a time.
  if (labels.length === 1) return tld === "localhost" || (port !== null && /\D/.test(tld));
  return port !== null || tld.startsWith("xn--") || /[^\p{ASCII}]/u.test(tld) || TLDS.has(tld);
}

/** `host:port` split apart, with a port that is a real one or none at all. */
function splitPort(authority: string): { host: string; port: number | null } | null {
  let host = authority;
  let port: string | null = null;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      port = rest.slice(1);
    }
  } else {
    const colon = authority.indexOf(":");
    if (colon >= 0) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
  }
  if (!host) return null;
  if (port === null) return { host, port: null };
  if (!/^\d+$/.test(port) || Number(port) > 65535) return null;
  return { host, port: Number(port) };
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
  { tabs, bookmarks, history, suggestions = [] }: { tabs: readonly Tab[]; bookmarks: readonly Bookmark[]; history: readonly HistoryEntry[]; suggestions?: readonly string[] },
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
  // The engine's completions come last: what Dive already knows about beats a
  // guess, and they are what fills the list when it knows nothing. They are
  // searches, not addresses, so they never take the first row from a site the
  // letters lead to.
  for (const phrase of suggestions) {
    if (rows.length >= limit) break;
    if (rows.some((row) => row.kind !== "suggest" && row.url.toLowerCase() === phrase.toLowerCase())) continue;
    if (phrase.toLowerCase() === needle) continue;
    rows.push({ kind: "suggest", url: phrase, title: phrase, favicon: null });
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
