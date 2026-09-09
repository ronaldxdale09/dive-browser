import { Accessibility, Activity, Ban, ClipboardList, Database, ExternalLink, FileSearch, Network, Shuffle, Terminal, X } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useLayout } from "../store/layout";
import type { Level } from "../lib/ipc";
import { jumpToSource, editorLabel } from "../lib/editor";
import { useBrowser } from "../store/browser";
import { selectEntries, useConsole } from "../store/console";
import type { ConsoleRow } from "../store/console";
import { usePrefs } from "../store/prefs";
import { Icon, IconButton } from "./Icon";
import { NetworkPanel, NetworkTools } from "./NetworkPanel";
import { RulesPanel, RulesTools } from "./RulesPanel";
import { StoragePanel } from "./StoragePanel";
import { MetaPanel } from "./MetaPanel";
import { A11yPanel } from "./A11yPanel";
import { VitalsPanel } from "./VitalsPanel";

const PANELS = [
  { id: "console", label: "Console", icon: Terminal },
  { id: "network", label: "Network", icon: Network },
  { id: "rules", label: "Rules", icon: Shuffle },
  { id: "storage", label: "Storage", icon: Database },
  { id: "a11y", label: "A11y", icon: Accessibility },
  { id: "vitals", label: "Vitals", icon: Activity },
  { id: "meta", label: "Meta", icon: FileSearch },
] as const;
type PanelId = (typeof PANELS)[number]["id"];

/** The panel an arrow, Home or End key lands on from `current`; null for other keys. */
export function stepPanel(key: string, current: PanelId): PanelId | null {
  const ids = PANELS.map((p) => p.id);
  const at = ids.indexOf(current);
  switch (key) {
    case "ArrowRight":
      return ids[(at + 1) % ids.length] ?? null;
    case "ArrowLeft":
      return ids[(at - 1 + ids.length) % ids.length] ?? null;
    case "Home":
      return ids[0] ?? null;
    case "End":
      return ids[ids.length - 1] ?? null;
    default:
      return null;
  }
}

/** Bottom developer dock. */
export function Dock() {
  // Remembered across launches: the panel you were reading is the one you
  // come back to.
  const panel: PanelId = useLayout((s) => s.dockPanel);
  const setPanel = useLayout((s) => s.setDockPanel);
  const toggle = useBrowser((s) => s.toggle);
  return (
    <section aria-label="Developer dock" className="flex min-h-0 flex-col bg-surface">
      <div className="flex min-w-0 items-center gap-1 px-2 pt-2 pb-1">
        <div
          role="tablist"
          aria-label="Dock panels"
          className="scroll-hidden flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          onKeyDown={(e) => {
            // The arrow keys move between panels the way they do in the
            // tab strip; Home and End jump to the ends.
            const next = stepPanel(e.key, panel);
            if (!next) return;
            e.preventDefault();
            setPanel(next);
            (e.currentTarget.querySelector(`[data-panel="${next}"]`) as HTMLElement | null)?.focus();
          }}
        >
          {PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`dock-tab-${p.id}`}
            data-panel={p.id}
            aria-selected={panel === p.id}
            aria-controls={`dock-panel-${p.id}`}
            tabIndex={panel === p.id ? 0 : -1}
            onClick={() => setPanel(p.id)}
            className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink aria-selected:bg-surface-3 aria-selected:text-ink"
          >
            <Icon icon={p.icon} size={13} />
            {p.label}
          </button>
          ))}
        </div>
        {panel === "console" && <ConsoleTools />}
        {panel === "network" && <NetworkTools />}
        {panel === "rules" && <RulesTools />}
        <span className="mx-0.5 h-4 w-px shrink-0 bg-line-2" aria-hidden />
        <IconButton icon={X} label="Close developer dock" size={13} onClick={() => toggle("dock", false)} tooltipAlign="end" />
      </div>
      <div role="tabpanel" id={`dock-panel-${panel}`} aria-labelledby={`dock-tab-${panel}`} className="flex min-h-0 flex-1 flex-col">
        {panel === "console" && <ConsolePanel />}
        {panel === "network" && <NetworkPanel />}
        {panel === "rules" && <RulesPanel />}
        {panel === "storage" && <StoragePanel />}
        {panel === "meta" && <MetaPanel />}
        {panel === "a11y" && <A11yPanel />}
        {panel === "vitals" && <VitalsPanel />}
      </div>
    </section>
  );
}

function ConsoleTools() {
  const activeTab = useBrowser((s) => s.activeTab);
  const clear = useConsole((s) => s.clear);
  const bugReport = useBrowser((s) => s.bugReport);
  return (
    <>
      <IconButton icon={ClipboardList} label="Copy bug report" size={13} disabled={!activeTab} onClick={() => void bugReport()} />
      <IconButton icon={Ban} label="Clear console" size={13} disabled={!activeTab} onClick={() => activeTab && clear(activeTab)} />
    </>
  );
}

const LEVEL_STYLE: Record<Level, string> = {
  debug: "text-ink-3",
  info: "text-ink",
  warn: "text-warn",
  error: "text-danger",
};

/** A single line of `leading-5` text with `py-0.5` and the row's bottom border; wrapped entries measure taller. */
const ROW_HEIGHT = 25;

/** Below this many pixels from the end, the user counts as reading the newest output. */
const BOTTOM_SLACK = 8;

/** A console row with how many identical lines in a row it stands for. */
export type ShownRow = ConsoleRow & { repeats: number };

/**
 * Fold a run of identical lines (same text, level, source and place) into
 * one row with a count, the way DevTools does, so a polling loop's twentieth
 * "Failed to load resource" does not push the line that matters off screen.
 * The row keeps the first line's id and the last line's timestamp.
 */
export function coalesce(rows: readonly ConsoleRow[]): ShownRow[] {
  const out: ShownRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.text === row.text && last.level === row.level && last.source === row.source && last.url === row.url && last.line === row.line) {
      last.repeats += 1;
      last.timestamp = row.timestamp;
    } else {
      out.push({ ...row, repeats: 1 });
    }
  }
  return out;
}

function ConsolePanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const entries = useConsole(selectEntries(activeTab));
  const preserve = useConsole((s) => s.preserve);
  const setPreserve = useConsole((s) => s.setPreserve);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the user was at the end the last time they scrolled; new output only pulls the view along then.
  const atBottom = useRef(true);
  // The filter also matches the level and source, so "error" or "network"
  // narrows to those lines the way a level picker would.
  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return coalesce(q ? entries.filter((e) => `${e.level} ${e.source} ${e.text}`.toLowerCase().includes(q)) : entries);
  }, [entries, filter]);

  // The React Compiler is not in use here; the virtualizer's mutable instance is intended.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => shown[i]?.id ?? i,
  });
  useEffect(() => {
    if (atBottom.current && shown.length > 0) virtualizer.scrollToEnd();
  }, [shown.length, virtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-2 pb-1 text-[11px] text-ink-3">
        <input
          aria-label="Filter console"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          className="h-6 w-56 rounded-md border border-line bg-surface-2 px-2 text-[11px] outline-none placeholder:text-ink-3 focus:border-highlight/60"
        />
        <label className="ml-auto flex items-center gap-1.5 select-none">
          <input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} className="accent-highlight" />
          Preserve log
        </label>
      </div>
      <div
        ref={scrollRef}
        data-testid="console-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
        }}
        className="min-h-0 flex-1 select-text overflow-auto font-mono text-[11.5px] leading-5"
      >
        {shown.length === 0 && (
          <div className="px-3 py-2 text-ink-3">{!activeTab ? "Open a tab to see its console." : entries.length > 0 ? "Nothing matches the filter." : "No console output yet."}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const e = shown[v.index]!;
            return <Row key={e.id} entry={e} tabId={activeTab} index={v.index} start={v.start} measure={virtualizer.measureElement} />;
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * How a console line names where it came from: the file, or the host when
 * the source is a document at a bare path ("example.com" rather than ""),
 * so a line from an inline script is not just ":3".
 */
export function sourceName(url: string): string {
  const last = url.split("?")[0]!.split("#")[0]!.split("/").pop() ?? "";
  if (last) return last;
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** One console line. Memoized on the entry object, so output arriving elsewhere in the list leaves it alone. */
const Row = memo(function Row({
  entry,
  tabId,
  index,
  start,
  measure,
}: {
  entry: ShownRow;
  tabId: string | null;
  index: number;
  start: number;
  measure: (node: HTMLDivElement | null) => void;
}) {
  const preferredEditor = usePrefs((s) => s.prefs.preferred_editor || "vscode");
  const loc = entry.url ? `${sourceName(entry.url)}${entry.line ? `:${entry.line}` : ""}` : "";
  const [jumping, setJumping] = useState(false);

  const handleClick = async () => {
    if (!entry.url || jumping) return;
    setJumping(true);
    try {
      const result = await jumpToSource(tabId, entry.url, entry.line, entry.column, preferredEditor);
      if (!result.opened) useBrowser.getState().notify(result.reason, 5000);
    } finally {
      setJumping(false);
    }
  };

  return (
    <div
      ref={measure}
      data-index={index}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start}px)` }}
      className={`flex gap-3 border-b border-line/60 px-3 py-0.5 ${LEVEL_STYLE[entry.level]}`}
    >
      <span className="w-14 shrink-0 text-ink-3">{entry.source}</span>
      {/* Colour alone must not carry the level: a warning and an error say so. */}
      {(entry.level === "warn" || entry.level === "error") && <span className="shrink-0 rounded bg-current/10 px-1 text-[10px] uppercase">{entry.level}</span>}
      {entry.repeats > 1 && (
        <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[10px] text-ink-2" title={`${entry.repeats} identical lines in a row`} aria-label={`${entry.repeats} times`}>
          ×{entry.repeats}
        </span>
      )}
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{entry.text}</span>
      {loc && (
        <button
          type="button"
          onClick={() => void handleClick()}
          title={`Open in ${editorLabel(preferredEditor)} (${entry.url})`}
          // A source can be a long URL; it yields to the message and shows whole on hover.
          className="group flex min-w-0 max-w-[40%] shrink items-center gap-1 rounded px-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
        >
          <span className="truncate">{loc}</span>
          <ExternalLink size={10} className="opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
    </div>
  );
});
