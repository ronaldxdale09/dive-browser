import { Command } from "cmdk";
import { ArrowUpRight, Search, Terminal, Server, History, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { events, ipc } from "../lib/ipc";
import { chromeCommands, formatChord, runCommand } from "../lib/commands";
import type { Bookmark, Command as CommandDef, DevServer, HistoryEntry, Tab } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { Favicon } from "./Favicon";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { tracePaletteLifecycle } from "../lib/inputTimingProbe";
import { leadsTo, titleOf } from "../lib/omnibox";

/**
 * How many history rows the palette offers. It is a launcher, not a history
 * browser: past five, the groups underneath stop being reachable without
 * scrolling, and the backend collapses near-duplicates so five rows are five
 * distinct sites.
 */
const HISTORY_LIMIT = 5;

/** Omnibox-style palette: type a URL or search, or pick a tab or command. */
/**
 * Rows match when every word typed appears somewhere in them. The library's
 * default is a scattered-letter match, which offered "Developer dock" for
 * "verge" because those letters occur in that order across the row.
 */
/**
 * Rows that can repeat (two tabs on the same page) carry their id after this
 * marker so cmdk can tell them apart; the filter ignores that part.
 */
export const ROW_ID = "\t";

export function paletteFilter(value: string, search: string): number {
  const haystack = value.split(ROW_ID)[0]!.toLowerCase();
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term)) ? 1 : 0;
}

/**
 * The site the typed letters begin ("exam" for example.com), taken from the
 * open tabs first, then bookmarks, then history: it is offered first, ahead
 * of the search row, as under the address bar. An address typed out keeps
 * the literal row first so Enter loads it afresh.
 */
export function leadingSite(query: string, tabs: readonly Tab[], bookmarks: readonly Bookmark[], history: readonly HistoryEntry[]): { kind: "tab"; tab: Tab } | { kind: "bookmark" | "history"; entry: Bookmark | HistoryEntry } | null {
  const needle = query.trim().toLowerCase();
  if (!needle || /\s/.test(needle) || /^[\w-]+(\.[\w-]+)+|^localhost|^https?:\/\//i.test(needle)) return null;
  const tab = tabs.find((t) => leadsTo(needle, t.url));
  if (tab) return { kind: "tab", tab };
  const bookmark = bookmarks.find((b) => leadsTo(needle, b.url));
  if (bookmark) return { kind: "bookmark", entry: bookmark };
  const entry = history.find((h) => leadsTo(needle, h.url));
  return entry ? { kind: "history", entry } : null;
}

export function Palette() {
  // The cover goes on synchronously with the mount -- a late cover leaves the
  // page painting over the palette -- and comes off when the fade-out ends.
  useCoversContent(true);
  const toggle = useBrowser((s) => s.toggle);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    tracePaletteLifecycle("palette-mounted", element);
    return () => tracePaletteLifecycle("palette-unmounted", element);
  }, []);
  useFocusTrap(root, { initialFocus: input });
  const openTab = useBrowser((s) => s.openTab);
  const tabs = useBrowser((s) => s.tabs);
  const activateTab = useBrowser((s) => s.activateTab);
  const [query, setQuery] = useState("");
  const [cmds, setCmds] = useState<CommandDef[]>([]);
  const [servers, setServers] = useState<DevServer[]>([]);
  const [visited, setHistory] = useState<HistoryEntry[]>([]);
  // A page that is open is offered as a tab, not again as history.
  const history = useMemo(() => {
    const open = new Set(tabs.map((t) => t.url));
    return visited.filter((h) => !open.has(h.url));
  }, [visited, tabs]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      ipc
        .historySearch(query, HISTORY_LIMIT)
        .then((h) => alive && setHistory(h))
        .catch(() => alive && setHistory([]));
      ipc
        .bookmarksSearch(query, 6)
        .then((b) => alive && setBookmarks(b))
        .catch(() => alive && setBookmarks([]));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);
  useEffect(() => {
    let alive = true;
    void ipc.commandsList().then((list) => alive && setCmds([...list, ...chromeCommands(list)])).catch(() => alive && setCmds([]));
    void ipc.devServersWatch(true).then((found) => alive && setServers(found)).catch(() => alive && setServers([]));
    const listener = events.devServersChanged.listen((event) => {
      if (alive) setServers(event.payload.servers);
    });
    return () => {
      alive = false;
      void ipc.devServersWatch(false).catch(() => undefined);
      void listener.then((unlisten) => unlisten());
    };
  }, []);

  const { close, className } = useFadeClose(() => toggle("palette", false));
  const go = async (url: string) => {
    close();
    await openTab(url);
  };
  const looksLikeUrl = /^[\w-]+(\.[\w-]+)+|^localhost|^https?:\/\//i.test(query.trim());
  const lead = useMemo(() => leadingSite(query, tabs, bookmarks, history), [query, tabs, bookmarks, history]);
  const leadUrl = lead === null ? null : lead.kind === "tab" ? lead.tab.url : lead.entry.url;
  const shownTabs = tabs.filter((t) => t.url !== leadUrl);
  const shownBookmarks = bookmarks.filter((b) => b.url !== leadUrl);
  const shownHistory = history.filter((h) => h.url !== leadUrl);

  // Opened to find a tab ("All tabs", ⌘⇧A), the open tabs lead the list.
  const tabsFirst = useBrowser((s) => s.paletteFocus === "tabs");
  const tabGroup = shownTabs.length > 0 && (
    <Command.Group heading="Tabs">
      {shownTabs.map((t) => (
        <Command.Item
          key={t.id}
          value={`${titleOf(t)} ${t.url}${ROW_ID}${t.id}`}
          onSelect={() => {
            close();
            void activateTab(t.id);
          }}
          className="flex items-center gap-2 rounded-lg px-3 py-2"
        >
          <Favicon src={t.favicon} size={14} />
          <span className="truncate">{titleOf(t)}</span>
          <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(t.url)}</span>
        </Command.Item>
      ))}
    </Command.Group>
  );
  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 ${className}`} onMouseDown={close}>
      <Command
        label="Command palette"
        role="dialog"
        aria-label={tabsFirst ? "Search tabs" : "Command palette"}
        aria-modal="true"
        shouldFilter={!!query}
        filter={paletteFilter}
        className="mx-auto mt-[min(12vh,96px)] w-[min(600px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Icon icon={Search} size={15} className="text-ink-3" />
          <Command.Input
            ref={input}
            value={query}
            onValueChange={setQuery}
            placeholder={tabsFirst ? "Search open tabs, or enter a URL" : "Search, enter a URL, or run a command"}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <Command.List className="max-h-80 overflow-auto p-1.5 text-xs">
          {lead && (
            <Command.Group value="lead">
              {lead.kind === "tab" ? (
                <Command.Item value={`${titleOf(lead.tab)} ${lead.tab.url}${ROW_ID}${lead.tab.id}`} onSelect={() => { close(); void activateTab(lead.tab.id); }} className="flex items-center gap-2 rounded-lg px-3 py-2">
                  <Favicon src={lead.tab.favicon} size={14} />
                  <span className="truncate">{titleOf(lead.tab)}</span>
                  <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-2">Switch to tab</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(lead.tab.url)}</span>
                </Command.Item>
              ) : (
                <Command.Item value={`${lead.kind} ${titleOf(lead.entry)} ${lead.entry.url}`} onSelect={() => void go(lead.entry.url)} className="flex items-center gap-2 rounded-lg px-3 py-2">
                  {lead.kind === "bookmark" ? <Favicon src={lead.entry.favicon} size={14} fallback={Star} fallbackClassName="text-highlight" /> : <Favicon src={lead.entry.favicon} size={14} fallback={History} />}
                  <span className="truncate">{titleOf(lead.entry)}</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(lead.entry.url)}</span>
                </Command.Item>
              )}
            </Command.Group>
          )}
          {query.trim() && (
            <Command.Group value="open">
              <Command.Item value={`open ${query}`} onSelect={() => void go(query)} className="flex items-center gap-2 rounded-lg px-3 py-2">
                <Icon icon={looksLikeUrl ? ArrowUpRight : Search} size={14} className="text-ink-3" />
                <span className="text-ink-2">{looksLikeUrl ? "Open" : "Search"}</span>
                <span className="truncate font-mono text-ink">{query}</span>
              </Command.Item>
            </Command.Group>
          )}
          {/* Open tabs come first: the thing most likely wanted is already open. */}
          {tabGroup}
          {servers.length > 0 && (
            <Command.Group heading="Local servers">
              {servers.map((d) => (
                <Command.Item key={d.port} value={`localhost ${d.port} ${d.framework} ${d.title}`} onSelect={() => void go(d.url)} className="flex items-center gap-2 rounded-lg px-3 py-2">
                  <Icon icon={Server} size={14} className="shrink-0 text-highlight" />
                  <span className="font-mono">localhost:{d.port}</span>
                  <span className="text-ink-2">{d.framework}</span>
                  {d.title && <span className="ml-auto truncate pl-3 text-[11px] text-ink-3">{d.title}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {shownHistory.length > 0 && (
            <Command.Group heading="History">
              {shownHistory.map((h) => (
                <Command.Item key={h.url} value={`history ${titleOf(h)} ${h.url}`} onSelect={() => void go(h.url)} className="flex items-center gap-2 rounded-lg px-3 py-2">
                  <Favicon src={h.favicon} size={14} fallback={History} />
                  <span className="truncate">{titleOf(h)}</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(h.url)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {shownBookmarks.length > 0 && (
            <Command.Group heading="Bookmarks">
              {shownBookmarks.map((b) => (
                <Command.Item key={b.url} value={`bookmark ${titleOf(b)} ${b.url}`} onSelect={() => void go(b.url)} className="flex items-center gap-2 rounded-lg px-3 py-2">
                  <Favicon src={b.favicon} size={14} fallback={Star} fallbackClassName="text-highlight" />
                  <span className="truncate">{titleOf(b)}</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(b.url)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Commands">
            {cmds.map((c) => (
              <Command.Item
                key={c.id}
                value={`${c.title} ${c.id}`}
                onSelect={() => {
                  close();
                  runCommand(c.id);
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-2"
              >
                <Icon icon={Terminal} size={14} className="shrink-0 text-ink-3" />
                <span>{c.title}</span>
                {c.keybinding && <kbd className="ml-auto rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{formatChord(c.keybinding)}</kbd>}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
        <div aria-hidden className="flex h-8 items-center gap-4 border-t border-line px-4 text-[11px] text-ink-3">
          <span><kbd className="font-mono">↑↓</kbd> move</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </Command>
    </div>
  );
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
