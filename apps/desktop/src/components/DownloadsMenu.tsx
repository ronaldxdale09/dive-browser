import { useDismiss } from "../lib/useDismiss";
import { Download, FolderOpen, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { selectActive, useDownloads } from "../store/downloads";
import type { Download as Item } from "../store/downloads";
import { usePrefs } from "../store/prefs";
import { EmptyState } from "./EmptyState";
import { FeatureButton } from "./FeatureBar";
import { Icon } from "./Icon";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { errorMessage } from "../lib/errors";
import { formatBytes } from "../lib/paths";

/** Downloads: what this session saved, where it went, and a way to the file. */
export function DownloadsMenu({ compact = false }: { compact?: boolean } = {}) {
  const items = useDownloads((s) => s.items);
  const active = useDownloads(selectActive);
  const clearList = useDownloads((s) => s.clear);
  // The engine keeps its own list, which is what an agent sees through MCP.
  // Clearing one and not the other means the button does not do what it says.
  const clear = useCallback(() => {
    clearList();
    void ipc.downloadsClear().catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  }, [clearList]);
  const folder = usePrefs((s) => s.prefs.download_dir) || "~/Downloads";
  const [open, setOpen] = useState(false);
  const dismiss = useCallback(() => setOpen(false), []);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open });

  useDismiss(ref, open, dismiss);

  // "just now" is computed at render, so a panel left open froze its times.
  // Ticking only while it is open costs nothing when it is not.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const reveal = (path: string | null) => {
    void ipc.downloadsReveal(path).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  };
  // One click opens, as in every browser's download shelf. Someone used to
  // Finder double-clicks it out of habit, which would open the file twice --
  // two windows for a document. A second click inside the system's
  // double-click interval is the same intent, not a second one.
  const lastOpen = useRef(0);
  const openFile = useCallback((path: string) => {
    const now = Date.now();
    if (now - lastOpen.current < 500) return;
    lastOpen.current = now;
    void ipc.downloadsOpen(path).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  }, []);
  const cancel = (id: number) => {
    void ipc.downloadsCancel(id).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  };

  return (
    <div ref={ref} className="relative">
      <FeatureButton icon={Download} label="Downloads" iconOnly={compact} active={open} hasPopup="dialog" onClick={() => setOpen((o) => !o)}>
        {active > 0 && (
          <span className="ml-0.5 rounded-full bg-highlight px-1.5 py-px font-mono text-[10px] leading-4 text-highlight-ink" aria-label={`${active} in progress`}>
            {active}
          </span>
        )}
      </FeatureButton>
      {open && (
        <div ref={panel} role="dialog" aria-label="Downloads" className="absolute right-0 z-50 mt-1 w-80 rounded-xl border border-line-2 bg-surface p-1.5 text-xs shadow-2xl">
          <div className="flex items-center px-2 pt-1 pb-1.5">
            <span className="text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">Downloads</span>
            <span className="flex-1" />
            <span className="max-w-40 truncate font-mono text-[10px] text-ink-3" title={folder}>
              {folder}
            </span>
          </div>
          {items.length === 0 ? (
            <EmptyState compact icon={Download} title="Nothing downloaded yet" hint={`Files save to ${folder}, never overwriting`} />
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {items.map((d) => (
                // Keyed on the file, not on its state: including `at` rebuilt
                // the row the moment it finished, taking keyboard focus off
                // the Show button with it.
                <Row
                  key={d.path || d.url}
                  item={d}
                  onReveal={() => reveal(d.path)}
                  onOpen={() => openFile(d.path)}
                  onCancel={d.id === undefined ? undefined : () => cancel(d.id as number)}
                />
              ))}
            </ul>
          )}
          <div className="mt-1 flex items-center gap-1 border-t border-line pt-1.5">
            <button type="button" onClick={() => reveal(null)} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink">
              <Icon icon={FolderOpen} size={12} /> Open folder
            </button>
            <span className="flex-1" />
            {items.length > 0 && (
              <button type="button" onClick={clear} className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink">
                <Icon icon={Trash2} size={12} /> Clear list
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ item, onReveal, onOpen, onCancel }: { item: Item; onReveal: () => void; onOpen: () => void; onCancel?: (() => void) | undefined }) {
  let host = "";
  try {
    host = new URL(item.url).host;
  } catch {
    host = "";
  }
  const running = item.status === "started";
  // A percentage needs a total, and a server that streams a chunked response
  // never sends one. Then the row shows what has arrived instead of inventing
  // a fraction, and the bar runs indeterminate.
  const total = item.total;
  const received = item.received ?? 0;
  const pct = running && total ? Math.min(100, Math.round((received / total) * 100)) : null;

  return (
    <li className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
      <span
        className={`size-2 shrink-0 rounded-full ${running ? "animate-pulse bg-highlight motion-reduce:animate-none" : item.status === "finished" ? "bg-highlight" : "bg-danger"}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        {item.status === "finished" && item.path ? (
          // The name opens the file, as in every browser's download shelf.
          // A habitual double-click would fire this twice and open the file
          // twice, so a second click inside the usual interval is ignored.
          <button type="button" onClick={onOpen} aria-label={`Open ${item.name}`} title={`Open ${item.path}`} className="block max-w-full truncate text-left text-ink hover:underline">
            {item.name}
          </button>
        ) : (
          <span className="block truncate text-ink" title={item.path || item.url}>
            {item.name}
          </span>
        )}
        {running && (
          <span
            role="progressbar"
            aria-label={`${item.name} download`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(pct === null ? {} : { "aria-valuenow": pct })}
            aria-valuetext={pct === null ? `${formatBytes(received)} downloaded` : `${pct}%`}
            className="mt-1 mb-0.5 block h-1 w-full overflow-hidden rounded-full bg-surface-3"
          >
            <span
              className={`block h-full rounded-full bg-highlight ${pct === null ? "w-1/3 animate-[dive-indeterminate_1.4s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:animate-none" : "transition-[width] duration-200 ease-out motion-reduce:transition-none"}`}
              {...(pct === null ? {} : { style: { width: `${pct}%` } })}
            />
          </span>
        )}
        <span className="block truncate text-[10.5px] text-ink-3">
          {running
            ? item.paused
              ? "Paused"
              : `${pct === null ? formatBytes(received) : `${pct}%`}${total ? ` of ${formatBytes(total)}` : ""}${item.speed ? ` · ${formatBytes(item.speed)}/s` : ""}`
            : item.status === "finished"
              ? `Saved${total ? ` · ${formatBytes(total)}` : ""}`
              : "Failed"}
          {host && ` · ${host}`} · {ago(item.at)}
        </span>
      </span>
      {running && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          aria-label={`Cancel ${item.name}`}
          title="Cancel"
          className="grid size-6 shrink-0 place-items-center rounded-full border border-line text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          <Icon icon={X} size={11} />
        </button>
      )}
      {item.status === "finished" && item.path && (
        <button
          type="button"
          onClick={onReveal}
          aria-label={`Show ${item.name} in folder`}
          className="h-6 shrink-0 rounded-full border border-line px-2 text-[10.5px] text-ink-2 opacity-0 hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          Show
        </button>
      )}
    </li>
  );
}

/** "just now", "3 min ago", "2 h ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
