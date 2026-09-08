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
        <div className="scroll-hidden flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={panel === p.id}
            onClick={() => setPanel(p.id)}
            className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-3 aria-pressed:text-ink"
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
      {panel === "console" && <ConsolePanel />}
      {panel === "network" && <NetworkPanel />}
      {panel === "rules" && <RulesPanel />}
      {panel === "storage" && <StoragePanel />}
      {panel === "meta" && <MetaPanel />}
      {panel === "a11y" && <A11yPanel />}
      {panel === "vitals" && <VitalsPanel />}
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

function ConsolePanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const entries = useConsole(selectEntries(activeTab));
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the user was at the end the last time they scrolled; new output only pulls the view along then.
  const atBottom = useRef(true);
  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? entries.filter((e) => e.text.toLowerCase().includes(q)) : entries;
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
      <div className="px-2 pb-1">
        <input
          aria-label="Filter console"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          className="h-6 w-56 rounded-md border border-line bg-surface-2 px-2 text-[11px] outline-none placeholder:text-ink-3 focus:border-line-2"
        />
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
        {shown.length === 0 && <div className="px-3 py-2 text-ink-3">{activeTab ? "No console output yet." : "Open a tab to see its console."}</div>}
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

/** One console line. Memoized on the entry object, so output arriving elsewhere in the list leaves it alone. */
const Row = memo(function Row({
  entry,
  tabId,
  index,
  start,
  measure,
}: {
  entry: ConsoleRow;
  tabId: string | null;
  index: number;
  start: number;
  measure: (node: HTMLDivElement | null) => void;
}) {
  const preferredEditor = usePrefs((s) => s.prefs.preferred_editor || "vscode");
  const loc = entry.url ? `${entry.url.split("/").pop() ?? entry.url}${entry.line ? `:${entry.line}` : ""}` : "";
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
