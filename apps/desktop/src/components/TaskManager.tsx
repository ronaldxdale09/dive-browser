import { Moon, RotateCw, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { TaskRow } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { errorMessage } from "../lib/errors";

/** The pause between one measurement finishing and the next starting. */
export const SAMPLE_MS = 2000;

export type SortKey = "title" | "memory" | "cpu" | "nodes";

/**
 * Keep the rows where they were: known tabs in their current places, new
 * ones after them, closed ones gone. A table that re-sorted itself on every
 * sample moved the row under the pointer just as it was clicked.
 */
export function stableOrder(previous: readonly string[], measured: readonly TaskRow[]): string[] {
  const present = new Set(measured.map((row) => row.tab_id));
  const kept = previous.filter((id) => present.has(id));
  const known = new Set(kept);
  return [...kept, ...measured.map((row) => row.tab_id).filter((id) => !known.has(id))];
}

/** The rows in `key` order, heaviest (or A first, for titles) at the top; unmeasured rows last. */
export function sortedOrder(rows: readonly TaskRow[], cpu: Record<string, number | null>, key: SortKey): string[] {
  const value = (row: TaskRow): number | null => (key === "memory" ? row.memory_bytes : key === "cpu" ? (cpu[row.tab_id] ?? null) : key === "nodes" ? row.nodes : null);
  return [...rows]
    .sort((a, b) => {
      if (key === "title") return a.title.localeCompare(b.title);
      const x = value(a);
      const y = value(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    })
    .map((row) => row.tab_id);
}

/** Bytes as a browser shows them: whole megabytes, which is the scale that matters here. */
export function formatMemory(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Processor use as a percentage of one core, from two cumulative readings.
 *
 * Chromium reports total task seconds, so a rate needs the previous sample.
 * A tab whose renderer restarted between samples reads lower than before;
 * that is a new process, not negative work, so it counts as nothing.
 */
export function cpuPercent(previous: { seconds: number; at: number } | undefined, seconds: number | null, at: number): number | null {
  if (seconds === null || !previous) return null;
  const elapsed = (at - previous.at) / 1000;
  if (elapsed <= 0) return null;
  const used = seconds - previous.seconds;
  if (used < 0) return null;
  return Math.min(100 * (used / elapsed), 999);
}

/**
 * Which tab is eating the machine.
 *
 * Alloy keeps no per-process counters an embedder can read, so each row is
 * the renderer's own account of itself: the JavaScript heap it holds and the
 * processor time its main thread has used. A sleeping tab has no renderer to
 * ask, and says so rather than reading as free.
 */
export function TaskManager() {
  const open = useBrowser((s) => s.open.tasks);
  const toggle = useBrowser((s) => s.toggle);
  const activateTab = useBrowser((s) => s.activateTab);
  const closeTab = useBrowser((s) => s.closeTab);
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [cpu, setCpu] = useState<Record<string, number | null>>({});
  // A failed read said "Measuring…" for ever. Whether a read has come back,
  // and why the last one did not, are kept apart so an empty table can say
  // which it is; `attempt` lets Retry ask again at once.
  const [measuredOnce, setMeasuredOnce] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const previous = useRef<Record<string, { seconds: number; at: number }>>({});
  const root = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(root, { active: open, onEscape: () => toggle("tasks", false) });

  useEffect(() => {
    if (!open) {
      previous.current = {};
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      try {
        const measured = await ipc.tasksList();
        if (!alive) return;
        setFailure(null);
        setMeasuredOnce(true);
        const at = Date.now();
        const rates: Record<string, number | null> = {};
        for (const row of measured) {
          rates[row.tab_id] = cpuPercent(previous.current[row.tab_id], row.cpu_seconds, at);
          if (row.cpu_seconds !== null) previous.current[row.tab_id] = { seconds: row.cpu_seconds, at };
        }
        setRows(measured);
        setOrder((prev) => stableOrder(prev, measured));
        setCpu(rates);
      } catch (e) {
        if (alive) setFailure(errorMessage(e));
      } finally {
        // The next sample is timed from this one's end, not on a fixed
        // clock: a slow measurement used to have the next one queued behind
        // it, and they piled up for as long as a tab kept stalling.
        if (alive) timer = setTimeout(() => void sample(), SAMPLE_MS);
      }
    };
    void sample();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, attempt]);

  if (!open) return null;
  const byId = new Map(rows.map((row) => [row.tab_id, row]));
  const shown = order.map((id) => byId.get(id)).filter((row): row is TaskRow => row !== undefined);
  const sortBy = (key: SortKey) => {
    setSortKey(key);
    setOrder(sortedOrder(rows, cpu, key));
  };
  const header = (key: SortKey, label: string, className: string) => (
    <th scope="col" className={className} aria-sort={sortKey === key ? (key === "title" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => sortBy(key)} title={`Sort by ${label.toLowerCase()}`} className="hover:text-ink">
        {label}
      </button>
    </th>
  );
  const total = rows.reduce((sum, row) => sum + (row.memory_bytes ?? 0), 0);
  const holders = rows.filter((row) => row.memory_bytes != null).length;
  const cell = "px-3 py-2 text-left";
  return (
    <div ref={root} className="overlay-backdrop fixed inset-0 z-50 grid place-items-center" onMouseDown={() => toggle("tasks", false)}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Task manager"
        className="max-h-[70vh] w-[min(720px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Task manager</h2>
          <span className="text-[11px] text-ink-3">{holders > 0 ? `${formatMemory(total)} of JavaScript in ${holders} ${holders === 1 ? "tab" : "tabs"} across this profile` : "No JavaScript heap reported"}</span>
          <button type="button" aria-label="Close task manager" title="Close task manager" onClick={() => toggle("tasks", false)} className="ml-auto grid size-6 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink">
            <Icon icon={X} size={12} />
          </button>
        </div>
        <div className="max-h-[calc(70vh-52px)] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface text-[11px] text-ink-3">
              <tr>
                {header("title", "Tab", cell)}
                {header("memory", "Memory", `${cell} w-24 text-right`)}
                {header("cpu", "CPU", `${cell} w-20 text-right`)}
                {header("nodes", "Nodes", `${cell} w-24 text-right`)}
                <th scope="col" className={`${cell} w-16`}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.tab_id} className="border-t border-line align-middle hover:bg-surface-2">
                  <td className={cell}>
                    <button type="button" title={row.title} onClick={() => void activateTab(row.tab_id)} className="flex min-w-0 max-w-[320px] items-center gap-1.5 text-left hover:underline">
                      {row.sleeping && <Icon icon={Moon} size={11} className="shrink-0 text-ink-3" />}
                      {row.audible && <Icon icon={Volume2} size={11} className="shrink-0 text-ink-2" />}
                      <span className="truncate">{row.title}</span>
                    </button>
                  </td>
                  <td className={`${cell} text-right font-mono text-ink-2`}>{row.sleeping ? "asleep" : formatMemory(row.memory_bytes)}</td>
                  <td className={`${cell} text-right font-mono text-ink-2`}>{cpu[row.tab_id] === null || cpu[row.tab_id] === undefined ? "—" : `${cpu[row.tab_id]!.toFixed(1)}%`}</td>
                  <td className={`${cell} text-right font-mono text-ink-3`}>{row.nodes === null ? "—" : Math.round(row.nodes).toLocaleString()}</td>
                  <td className={`${cell} text-right`}>
                    <button type="button" aria-label={`Close ${row.title}`} onClick={() => void closeTab(row.tab_id)} className="rounded-full px-2 py-1 text-[11px] text-ink-3 hover:bg-surface-3 hover:text-ink">
                      Close
                    </button>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-ink-3">
                    {failure ? (
                      <span role="alert" className="inline-flex flex-wrap items-center justify-center gap-2">
                        <span className="text-danger">Could not measure the tabs: {failure}</span>
                        <button type="button" onClick={() => setAttempt((n) => n + 1)} className="inline-flex h-6 items-center gap-1 rounded-md border border-line-2 px-2 text-ink hover:bg-surface-2">
                          <Icon icon={RotateCw} size={11} /> Retry
                        </button>
                      </span>
                    ) : measuredOnce ? (
                      "No tabs are open in this profile."
                    ) : (
                      <span role="status">Measuring…</span>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
