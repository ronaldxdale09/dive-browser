import { RefreshCw } from "lucide-react";
import { ipc } from "../lib/ipc";
import { useTabData } from "../lib/useTabData";
import { useBrowser } from "../store/browser";
import { IconButton } from "./Icon";

/** Head metadata with a search-result and a social-card preview. */
export function MetaPanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const url = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab)?.url ?? "");
  const { data: meta, error, refresh } = useTabData(activeTab, url, ipc.tabMeta);

  if (!activeTab) return <div className="px-3 py-2 text-xs text-ink-3">Open a tab to inspect its metadata.</div>;
  if (error) return <div className="px-3 py-2 text-xs text-danger">{error}</div>;
  if (!meta) return <div className="px-3 py-2 text-xs text-ink-3">Reading…</div>;

  const ogTitle = meta.og["title"] ?? meta.title;
  const ogDesc = meta.og["description"] ?? meta.description ?? "";
  const ogImage = meta.og["image"] ?? meta.twitter["image"];
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const rows: [string, string | undefined][] = [
    ["title", meta.title],
    ["description", meta.description ?? undefined],
    ["canonical", meta.canonical ?? undefined],
    ["lang", meta.lang ?? undefined],
    ["viewport", meta.viewport ?? undefined],
    ["robots", meta.robots ?? undefined],
    ...Object.entries(meta.og).map(([k, v]): [string, string] => [`og:${k}`, v]),
    ...Object.entries(meta.twitter).map(([k, v]): [string, string] => [`twitter:${k}`, v]),
  ];

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-auto px-3 py-2 select-text">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center">
          <span className="text-[10px] tracking-wider text-ink-3 uppercase">Head</span>
          <span className="flex-1" />
          <IconButton icon={RefreshCw} label="Re-read metadata" size={12} onClick={refresh} />
        </div>
        <div className="font-mono text-[11.5px] leading-5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3 border-b border-line/60 py-0.5">
              <span className="w-32 shrink-0 text-ink-3">{k}</span>
              <span className={`min-w-0 flex-1 break-words ${v ? "text-ink" : "text-danger"}`}>{v ?? "missing"}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex w-80 shrink-0 flex-col gap-3">
        <div>
          <div className="mb-1 text-[10px] tracking-wider text-ink-3 uppercase">Search result</div>
          <div className="rounded-lg border border-line bg-surface-2 p-3">
            <div className="truncate text-[11px] text-ink-3">{host}</div>
            <div className="truncate text-sm text-[#8ab4f8]">{meta.title || "(no title)"}</div>
            <div className="line-clamp-2 text-xs text-ink-2">{meta.description ?? "No description. Search engines will pick text from the page."}</div>
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] tracking-wider text-ink-3 uppercase">Social card</div>
          <div className="overflow-hidden rounded-lg border border-line bg-surface-2">
            {ogImage ? (
              <img src={ogImage} alt="" className="aspect-[1.91/1] w-full object-cover" />
            ) : (
              <div className="grid aspect-[1.91/1] place-items-center text-xs text-ink-3">no og:image</div>
            )}
            <div className="p-2.5">
              <div className="truncate text-[11px] text-ink-3">{host}</div>
              <div className="truncate text-xs font-medium text-ink">{ogTitle || "(no title)"}</div>
              <div className="line-clamp-2 text-[11px] text-ink-2">{ogDesc}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
