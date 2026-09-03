import { ArrowDownLeft, ArrowUpRight, Ban, FileDown, FileJson, Repeat } from "lucide-react";
import { useState } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { isReady, useAgent } from "../store/agent";
import { usePrefs } from "../store/prefs";
import { selectFrames, selectRequests, useNetwork } from "../store/network";
import type { RequestRow } from "../store/network";
import { Icon, IconButton } from "./Icon";
import { ReplayEditor } from "./ReplayEditor";
import { AgentIcon } from "./agent/AgentIcon";

export function NetworkTools() {
  const activeTab = useBrowser((s) => s.activeTab);
  const clear = useNetwork((s) => s.clear);
  const exportWith = (run: (tab: string) => Promise<string>, label: string) => () => {
    if (!activeTab) return;
    run(activeTab)
      .then((path) => useBrowser.setState({ notice: `${label} · saved ${path.split("/").pop() ?? path}` }))
      .catch((e: unknown) => useBrowser.setState({ error: e instanceof Error ? e.message : String(e) }));
    setTimeout(() => useBrowser.setState({ notice: null }), 4000);
  };
  return (
    <>
      <IconButton icon={FileDown} label="Export HAR" size={13} disabled={!activeTab} onClick={exportWith(ipc.tabHar, "HAR exported")} />
      <IconButton icon={FileJson} label="Export OpenAPI from captured traffic" size={13} disabled={!activeTab} onClick={exportWith(ipc.tabOpenapi, "OpenAPI copied")} />
      <IconButton icon={Ban} label="Clear requests" size={13} disabled={!activeTab} onClick={() => activeTab && clear(activeTab)} />
    </>
  );
}

function name(url: string) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return (last ?? u.host) + (u.search ? "?" : "");
  } catch {
    return url;
  }
}

function size(n: number | null) {
  if (n === null) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function statusClass(r: RequestRow) {
  if (r.error) return "text-danger";
  if (r.status === null) return "text-ink-3";
  if (r.status >= 400) return "text-danger";
  if (r.status >= 300) return "text-[#f0b35e]";
  return "text-ink-2";
}

/** Request table for the active tab with a detail strip for the selected row. */
export function NetworkPanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const rows = useNetwork(selectRequests(activeTab));
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);
  const send = useAgent((s) => s.send);
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const providerId = usePrefs((s) => s.prefs.agent_provider);
  const keyPresent = isReady(providers.find((p) => p.id === providerId), keyed);
  const askAgent = (r: RequestRow) => {
    useBrowser.getState().toggle("sidecar", true);
    const outcome = r.error ?? (r.status === null ? "no response yet" : `HTTP ${r.status}`);
    void send(
      `Explain this request from the current page and whether it looks right:\n\n${r.method} ${r.url}\nResult: ${outcome}${r.mimeType ? ` (${r.mimeType})` : ""}${r.size !== null ? `, ${r.size} bytes` : ""}${r.durationMs !== null ? `, ${r.durationMs} ms` : ""}\n\nRequest id ${r.id}: call network_body for its JSON body, or console_tail for related errors. If it failed, say why and how to fix it.`,
      activeTab,
    );
  };
  const shown = filter ? rows.filter((r) => r.url.toLowerCase().includes(filter.toLowerCase())) : rows;
  const detail = rows.find((r) => r.id === selected);
  const frames = useNetwork(selectFrames(activeTab, selected));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-2 pb-1 text-[11px] text-ink-3">
        <input
          aria-label="Filter requests"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          className="h-6 w-56 rounded-md border border-line bg-surface-2 px-2 text-[11px] text-ink outline-none placeholder:text-ink-3 focus:border-line-2"
        />
        <span>{rows.length} requests</span>
        <span>{size(rows.reduce((a, r) => a + (r.size ?? 0), 0))} transferred</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-5">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface text-left text-[10px] tracking-wider text-ink-3 uppercase">
            <tr>
              <th className="px-3 font-medium">Name</th>
              <th className="px-2 font-medium">Method</th>
              <th className="px-2 font-medium">Status</th>
              <th className="px-2 font-medium">Type</th>
              <th className="px-2 text-right font-medium">Size</th>
              <th className="px-3 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-2 text-ink-3">{activeTab ? "No requests yet." : "Open a tab to see its traffic."}</td>
              </tr>
            )}
            {shown.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r.id === selected ? null : r.id)}
                aria-selected={r.id === selected}
                className="cursor-default border-b border-line/60 hover:bg-surface-2 aria-selected:bg-surface-3"
              >
                <td className="max-w-[360px] truncate px-3 text-ink" title={r.url}>{name(r.url)}</td>
                <td className="px-2 text-ink-2">{r.method}</td>
                <td className={`px-2 ${statusClass(r)}`}>{r.error ? "failed" : (r.status ?? "…")}{r.fromCache ? " (cache)" : ""}</td>
                <td className="px-2 text-ink-2">{r.resourceType.toLowerCase()}</td>
                <td className="px-2 text-right text-ink-2 tabular-nums">{size(r.size)}</td>
                <td className="px-3 text-right text-ink-2 tabular-nums">{r.durationMs === null ? "" : `${r.durationMs} ms`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && frames.length > 0 && (
        <div className="max-h-40 overflow-auto border-t border-line font-mono text-[11px]">
          {frames.map((f, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-line/60 px-3 py-1">
              <Icon icon={f.direction === "sent" ? ArrowUpRight : ArrowDownLeft} size={11} className={f.direction === "sent" ? "mt-0.5 shrink-0 text-ink-3" : "mt-0.5 shrink-0 text-accent"} />
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap text-ink-2 select-text">{f.payload}</span>
              <span className="shrink-0 text-ink-3 tabular-nums">{frames[0] ? `+${Math.round((f.at - frames[0].at) * 1000)} ms` : ""}</span>
            </div>
          ))}
        </div>
      )}
      {detail && replaying !== detail.id && (
        <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-ink-2 select-text">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-ink">{detail.method}</span> {detail.url}
            {detail.mimeType && <span className="ml-3 text-ink-3">{detail.mimeType}</span>}
            {detail.error && <span className="ml-3 text-danger">{detail.error}</span>}
          </span>
          <button type="button" onClick={() => setReplaying(detail.id)} className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-line px-2 font-sans text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
            <Icon icon={Repeat} size={11} /> Replay
          </button>
          <button
            type="button"
            disabled={!keyPresent}
            title={keyPresent ? "Ask the agent about this request" : "Add an API key in the Agent sidecar first"}
            onClick={() => askAgent(detail)}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line px-2 font-sans text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-40"
          >
            <AgentIcon size={11} className="text-highlight" /> Explain
          </button>
        </div>
      )}
      {detail && replaying === detail.id && activeTab && <ReplayEditor tabId={activeTab} requestId={detail.id} onClose={() => setReplaying(null)} />}
    </div>
  );
}
