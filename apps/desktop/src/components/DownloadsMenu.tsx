import { Download, FolderOpen, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

/** Downloads: what this session saved, where it went, and a way to the file. */
export function DownloadsMenu({ compact = false }: { compact?: boolean } = {}) {
  const items = useDownloads((s) => s.items);
  const active = useDownloads(selectActive);
  const clear = useDownloads((s) => s.clear);
  const folder = usePrefs((s) => s.prefs.download_dir) || "~/Downloads";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const reveal = (path: string | null) => {
    void ipc.downloadsReveal(path).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  };

  return (
    <div ref={ref} className="relative">
      <FeatureButton icon={Download} label="Downloads" iconOnly={compact} active={open} onClick={() => setOpen((o) => !o)}>
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
                <Row key={`${d.path}|${d.url}|${d.at}`} item={d} onReveal={() => reveal(d.path)} />
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

function Row({ item, onReveal }: { item: Item; onReveal: () => void }) {
  let host = "";
  try {
    host = new URL(item.url).host;
  } catch {
    host = "";
  }
  return (
    <li className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
      <span
        className={`size-2 shrink-0 rounded-full ${item.status === "started" ? "animate-pulse bg-highlight motion-reduce:animate-none" : item.status === "finished" ? "bg-highlight" : "bg-danger"}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink" title={item.path || item.url}>
          {item.name}
        </span>
        <span className="block truncate text-[10.5px] text-ink-3">
          {item.status === "started" ? "Downloading…" : item.status === "finished" ? "Saved" : "Failed"}
          {host && ` · ${host}`} · {ago(item.at)}
        </span>
      </span>
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
