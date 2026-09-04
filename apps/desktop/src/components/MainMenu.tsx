import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  Bug,
  Camera,
  ChevronRight,
  Clapperboard,
  Download,
  History,
  Keyboard,
  LayoutGrid,
  Maximize,
  Minus,
  PanelBottom,
  Plus,
  Printer,
  Search,
  Settings2,
  Smartphone,
  SquarePlus,
  Star,
  TextSearch,
  Trash2,
  Video,
  Wand2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { runCommand } from "../lib/commands";
import { ipc } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { screenUrl } from "./internal/InternalPage";
import { useBrowser } from "../store/browser";
import { useRecording } from "../store/recording";
import { usePicker } from "../store/simulator";
import { AgentIcon } from "./agent/AgentIcon";
import { Icon } from "./Icon";

/**
 * The application menu behind the three lines at the end of the toolbar:
 * every feature and page Dive has, grouped the way a browser menu is, with
 * a search box so nothing has to be remembered. Typing filters the list
 * and Enter runs the first match.
 */
interface Item {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Custom glyph instead of a lucide icon. */
  glyph?: React.ReactNode;
  shortcut?: string;
  /** Shown as a chevron: the item opens somewhere else. */
  more?: boolean;
  keywords?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

interface Group {
  id: string;
  items: Item[];
}

export function MainMenu() {
  useCoversContent(true);
  const toggle = useBrowser((s) => s.toggle);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { close, className } = useFadeClose(() => toggle("menu", false));
  useFocusTrap(root, { initialFocus: input, onEscape: close });
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const groups = useMenu(close);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return groups;
    return groups.map((g) => ({ ...g, items: g.items.filter((i) => `${i.label} ${i.keywords ?? ""}`.toLowerCase().includes(q)) })).filter((g) => g.items.length > 0);
  }, [groups, q]);
  const flat = filtered.flatMap((g) => g.items);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      const item = flat[cursor];
      if (item && !item.disabled) {
        e.preventDefault();
        void item.run();
      }
    }
  };

  let index = -1;
  return (
    <div ref={root} className={`fixed inset-0 z-50 ${className}`} onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="absolute top-[86px] right-3 flex max-h-[calc(100vh-100px)] w-[340px] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <label className="m-2 flex h-9 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface-2 px-2.5 focus-within:border-line-2">
          <Icon icon={Search} size={13} className="shrink-0 text-ink-3" />
          <input
            ref={input}
            aria-label="Search the menu"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }} placeholder="Search features and pages" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
          {query && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => {
                setQuery("");
                setCursor(0);
              }} className="grid size-5 place-items-center rounded-full text-ink-3 hover:text-ink">
              <Icon icon={X} size={12} />
            </button>
          )}
        </label>
        <div role="menu" className="scroll-hidden min-h-0 flex-1 overflow-y-auto pb-2">
          {flat.length === 0 && <p className="px-4 py-6 text-center text-xs text-ink-3">Nothing matches “{query}”.</p>}
          {filtered.map((g, gi) => (
            <div key={g.id} className={gi > 0 ? "mt-1 border-t border-line pt-1" : ""}>
              {g.id === "zoom" ? (
                <ZoomRow />
              ) : (
                g.items.map((item) => {
                  index += 1;
                  const i = index;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => void item.run()}
                      className={`flex h-9 w-full items-center gap-3 px-4 text-left text-[13px] text-ink transition-colors disabled:opacity-40 ${cursor === i ? "bg-surface-2" : ""}`}
                    >
                      <span className="grid size-5 shrink-0 place-items-center text-ink-2">{item.glyph ?? (item.icon && <Icon icon={item.icon} size={15} />)}</span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.shortcut && <kbd className="font-mono text-[11px] text-ink-3">{item.shortcut}</kbd>}
                      {item.more && <Icon icon={ChevronRight} size={13} className="text-ink-3" />}
                    </button>
                  );
                })
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** − 100% + and a fullscreen toggle, as one row like a browser menu's. */
function ZoomRow() {
  const active = useBrowser((s) => s.activeTab);
  const zoom = useBrowser((s) => (s.activeTab ? (s.zoom[s.activeTab] ?? 1) : 1));
  const zoomStep = useBrowser((s) => s.zoomStep);
  const [full, setFull] = useState(false);
  useEffect(() => {
    void getCurrentWindow()
      .isFullscreen()
      .then(setFull)
      .catch(() => undefined);
  }, []);
  return (
    <div className="flex h-10 items-center gap-3 px-4 text-[13px] text-ink">
      <span className="grid size-5 place-items-center text-ink-2">
        <Icon icon={Search} size={15} />
      </span>
      <span className="flex-1">Zoom</span>
      <button type="button" aria-label="Zoom out" disabled={!active} onClick={() => void zoomStep(-1)} className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
        <Icon icon={Minus} size={14} />
      </button>
      <button type="button" aria-label="Reset zoom" onClick={() => void zoomStep(0)} className="w-12 rounded-md py-1 text-center font-mono text-[12px] tabular-nums hover:bg-surface-2">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" disabled={!active} onClick={() => void zoomStep(1)} className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
        <Icon icon={Plus} size={14} />
      </button>
      <span className="mx-1 h-5 w-px bg-line-2" aria-hidden />
      <button
        type="button"
        aria-label={full ? "Leave full screen" : "Full screen"}
        aria-pressed={full}
        onClick={() => {
          const w = getCurrentWindow();
          void w
            .isFullscreen()
            .then((f) => w.setFullscreen(!f).then(() => setFull(!f)))
            .catch(() => undefined);
        }}
        className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink aria-pressed:text-highlight"
      >
        <Icon icon={Maximize} size={14} />
      </button>
    </div>
  );
}

/** Everything the menu offers, built from the stores so states are live. */
function useMenu(close: () => void): Group[] {
  const active = useBrowser((s) => s.activeTab);
  const open = useBrowser((s) => s.open);
  const detached = useBrowser((s) => s.detached);
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    void ipc
      .recordingsList()
      .then((list) => setLatest(list.find((r) => r.editable)?.path ?? null))
      .catch(() => undefined);
  }, []);
  const b = () => useBrowser.getState();
  const done = (fn: () => void | Promise<void>) => () => {
    close();
    return fn();
  };
  return [
    {
      id: "new",
      items: [
        { id: "window.new", label: "New Window", icon: AppWindow, shortcut: "⌘N", run: done(() => runCommand("window.new")) },
        { id: "tab.new", label: "New Tab", icon: SquarePlus, shortcut: "⌘T", run: done(() => runCommand("tab.new")) },
        { id: "workspace.new", label: "New Workspace", icon: LayoutGrid, keywords: "container profile", run: done(() => runCommand("workspace.new")) },
        {
          id: "tab.detach",
          label: active && detached.includes(active) ? "Bring Tab Back to This Window" : "Move Tab to New Window",
          icon: AppWindow,
          disabled: !active,
          keywords: "popout window",
          run: done(() => (active ? (detached.includes(active) ? b().attachTab(active) : b().detachTab(active, null)) : undefined)),
        },
      ],
    },
    {
      id: "dive",
      items: [
        { id: "record", label: "Record a Video", icon: Video, shortcut: "⌘⇧R", keywords: "screen recording gif capture loom", disabled: !active, run: done(() => useRecording.getState().openSetup()) },
        { id: "divescreen", label: "Edit Latest Recording in DiveScreen", icon: Clapperboard, keywords: "editor zoom trim video", disabled: !latest, run: done(() => (latest ? b().openTab(screenUrl(latest)) : undefined)) },
        { id: "simulator", label: "Device Simulator", icon: Smartphone, shortcut: "⌘⇧M", keywords: "mobile phone responsive emulate", disabled: !active, run: done(() => usePicker.getState().toggle()) },
        { id: "agent", label: "Agent", glyph: <AgentIcon size={15} className="text-highlight" />, shortcut: "⌘J", keywords: "ai assistant sidecar chat", run: done(() => b().toggle("sidecar")) },
        { id: "dock", label: "Developer Dock", icon: PanelBottom, shortcut: "⌘⇧D", keywords: "console network vitals storage", run: done(() => b().toggle("dock")) },
        { id: "devtools", label: "DevTools", icon: Bug, shortcut: "⌘⌥I", disabled: !active, run: done(() => runCommand("tab.devtools")) },
        { id: "capture", label: "Capture Full Page", icon: Camera, shortcut: "⌘⇧S", keywords: "screenshot annotate", disabled: !active, run: done(() => runCommand("capture.fullpage")) },
        { id: "report", label: "Report a Bug…", icon: Wand2, shortcut: "⌘⇧B", keywords: "issue compose", disabled: !active, run: done(() => runCommand("report.compose")) },
      ],
    },
    {
      id: "library",
      items: [
        { id: "bookmarks", label: "Bookmarks", icon: Star, shortcut: "⌘⌥B", more: true, keywords: "favorites saved", run: () => b().openLibrary("bookmarks") },
        { id: "history", label: "History", icon: History, shortcut: "⌘Y", more: true, keywords: "visited recent", run: () => b().openLibrary("history") },
        { id: "downloads", label: "Downloads", icon: Download, shortcut: "⌘⇧J", more: true, keywords: "files saved", run: () => b().openLibrary("downloads") },
        { id: "recordings", label: "Recordings", icon: Clapperboard, more: true, keywords: "videos gifs captures", run: () => b().openLibrary("recordings") },
        { id: "clear", label: "Delete Browsing Data…", icon: Trash2, keywords: "cookies cache privacy clear", run: done(() => b().openSettings("privacy")) },
      ],
    },
    { id: "zoom", items: [{ id: "zoom", label: "Zoom", keywords: "bigger smaller full screen", run: () => undefined }] },
    {
      id: "page",
      items: [
        { id: "print", label: "Print…", icon: Printer, shortcut: "⌘P", disabled: !active, run: done(() => runCommand("tab.print")) },
        { id: "find", label: "Find in Page", icon: TextSearch, shortcut: "⌘F", disabled: !active, run: done(() => b().toggle("find", true)) },
        { id: "palette", label: "Command Palette", icon: Search, shortcut: "⌘K", keywords: "search everything", run: done(() => b().toggle("palette", true)) },
      ],
    },
    {
      id: "app",
      items: [
        { id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard, shortcut: "⌘/", more: true, run: done(() => b().toggle("shortcuts", true)) },
        { id: "help", label: "About Dive", icon: Bug, keywords: "help version", run: done(() => b().openSettings("about")) },
        { id: "settings", label: "Settings", icon: Settings2, shortcut: "⌘,", active: open.settings, run: done(() => b().openSettings()) } as Item & { active?: boolean },
      ],
    },
  ];
}
