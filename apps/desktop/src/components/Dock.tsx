import { Accessibility, Activity, Ban, Database, FileSearch, Network, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConsoleEntry, Level } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { selectEntries, useConsole } from "../store/console";
import { Icon, IconButton } from "./Icon";

const PANELS = [
  { id: "console", label: "Console", icon: Terminal },
  { id: "network", label: "Network", icon: Network },
  { id: "storage", label: "Storage", icon: Database },
  { id: "a11y", label: "A11y", icon: Accessibility },
  { id: "vitals", label: "Vitals", icon: Activity },
  { id: "meta", label: "Meta", icon: FileSearch },
] as const;
type PanelId = (typeof PANELS)[number]["id"];

/** Bottom developer dock. */
export function Dock() {
  const [panel, setPanel] = useState<PanelId>("console");
  return (
    <section aria-label="Developer dock" className="flex min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        {PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={panel === p.id}
            onClick={() => setPanel(p.id)}
            className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-3 aria-pressed:text-ink"
          >
            <Icon icon={p.icon} size={13} />
            {p.label}
          </button>
        ))}
        <span className="flex-1" />
        {panel === "console" && <ConsoleTools />}
      </div>
      {panel === "console" ? <ConsolePanel /> : <div className="flex-1 px-3 py-2 text-xs text-ink-3">Coming in Phase 2.</div>}
    </section>
  );
}

function ConsoleTools() {
  const activeTab = useBrowser((s) => s.activeTab);
  const clear = useConsole((s) => s.clear);
  return <IconButton icon={Ban} label="Clear console" size={13} disabled={!activeTab} onClick={() => activeTab && clear(activeTab)} />;
}

const LEVEL_STYLE: Record<Level, string> = {
  debug: "text-ink-3",
  info: "text-ink",
  warn: "text-[#f0b35e]",
  error: "text-danger",
};

function ConsolePanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const entries = useConsole(selectEntries(activeTab));
  const [filter, setFilter] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);
  const shown = filter ? entries.filter((e) => e.text.toLowerCase().includes(filter.toLowerCase())) : entries;

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
      <div className="min-h-0 flex-1 select-text overflow-auto font-mono text-[11.5px] leading-5">
        {shown.length === 0 && <div className="px-3 py-2 text-ink-3">{activeTab ? "No console output yet." : "Open a tab to see its console."}</div>}
        {shown.map((e, i) => (
          <Row key={`${e.timestamp}-${i}`} entry={e} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function Row({ entry }: { entry: ConsoleEntry }) {
  const loc = entry.url ? `${entry.url.split("/").pop() ?? entry.url}${entry.line ? `:${entry.line}` : ""}` : "";
  return (
    <div className={`flex gap-3 border-b border-line/60 px-3 py-0.5 ${LEVEL_STYLE[entry.level]}`}>
      <span className="w-14 shrink-0 text-ink-3">{entry.source}</span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{entry.text}</span>
      {loc && <span className="shrink-0 text-ink-3" title={entry.url ?? undefined}>{loc}</span>}
    </div>
  );
}
