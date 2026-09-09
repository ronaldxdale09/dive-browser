import { ArrowDownLeft, ArrowUpRight, Ban, Copy, FileDown, FileJson, Repeat, Terminal } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { isReady, useAgent } from "../store/agent";
import { usePrefs } from "../store/prefs";
import { selectFrames, selectRequests, useNetwork } from "../store/network";
import { useLayout } from "../store/layout";
import type { RequestRow } from "../store/network";
import type { RequestDetail } from "../lib/ipc";
import { Icon, IconButton } from "./Icon";
import { ReplayEditor } from "./ReplayEditor";
import { AgentIcon } from "./agent/AgentIcon";
import { errorMessage } from "../lib/errors";
import { prettyJson, toCurl } from "../lib/curl";
import { copyText } from "../lib/clipboard";

export function NetworkTools() {
  const activeTab = useBrowser((s) => s.activeTab);
  const clear = useNetwork((s) => s.clear);
  const exportWith = (run: (tab: string) => Promise<string>, label: string) => () => {
    if (!activeTab) return;
    run(activeTab)
      .then((path) => useBrowser.getState().notify(`${label} · saved ${path.split("/").pop() ?? path}`, 4000))
      .catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
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
    // The query is part of the name, as in Chrome; the cell truncates it.
    return (last ?? u.host) + u.search;
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

/** What the status column says: a rule or the blocklist stopping a request is not the page failing. */
export function outcomeLabel(r: { error: string | null; status: number | null }): string {
  if (r.error === "canceled") return "canceled";
  // A rule or the inspector blocks with "blocked: <reason>"; the network
  // stack reports its own blocks as net::ERR_BLOCKED_BY_*.
  if (r.error && /^blocked\b|BLOCKED_BY_/i.test(r.error)) return "blocked";
  if (r.error) return "failed";
  return r.status === null ? "…" : String(r.status);
}

function statusClass(r: RequestRow) {
  if (r.error === "canceled") return "text-ink-3";
  if (r.error) return "text-danger";
  if (r.status === null) return "text-ink-3";
  if (r.status >= 400) return "text-danger";
  if (r.status >= 300) return "text-warn";
  return "text-ink-2";
}

/** One request. Memoized on its row object and selection flag so a lifecycle event for another request leaves it alone. */
const NetworkRow = memo(function NetworkRow({
  row: r,
  index,
  selected,
  onSelect,
  measure,
}: {
  row: RequestRow;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
  measure: (node: HTMLTableRowElement | null) => void;
}) {
  return (
    <tr
      ref={measure}
      data-index={index}
      tabIndex={0}
      onClick={() => onSelect(r.id)}
      onKeyDown={(e) => {
        // Rows are reachable with Tab; Enter or Space opens the detail like a click.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(r.id);
        }
      }}
      aria-selected={selected}
      className="cursor-default border-b border-line/60 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-inset aria-selected:bg-surface-3"
    >
      <td className="max-w-[360px] truncate px-3 text-ink" title={r.url}>{name(r.url)}</td>
      <td className="px-2 text-ink-2">{r.method}</td>
      <td className={`px-2 ${statusClass(r)}`} title={r.error ?? undefined}>{outcomeLabel(r)}{r.mocked ? " (mock)" : r.fromCache ? " (cache)" : ""}</td>
      <td className="px-2 text-ink-2">{r.resourceType.toLowerCase()}</td>
      <td className="px-2 text-right text-ink-2 tabular-nums">{size(r.size)}</td>
      <td className="px-3 text-right text-ink-2 tabular-nums">{r.durationMs === null ? "" : `${r.durationMs} ms`}</td>
    </tr>
  );
});

/** A single line of `leading-5` text plus the row's bottom border. */
const ROW_HEIGHT = 21;

/** Request table for the active tab with a detail strip for the selected row. Only the rows in view are mounted. */
/** Dock height that shows a replay editor whole, within the window's own ceiling. */
const REPLAY_DOCK_HEIGHT = 440;

export function NetworkPanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const rows = useNetwork(selectRequests(activeTab));
  const preserve = useNetwork((s) => s.preserve);
  const setPreserve = useNetwork((s) => s.setPreserve);
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
  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? rows.filter((r) => r.url.toLowerCase().includes(q)) : rows;
  }, [rows, filter]);
  const transferred = useMemo(() => rows.reduce((a, r) => a + (r.size ?? 0), 0), [rows]);
  const detail = useMemo(() => rows.find((r) => r.id === selected), [rows, selected]);
  const frames = useNetwork(selectFrames(activeTab, selected));
  const select = useCallback((id: string) => setSelected((cur) => (cur === id ? null : id)), []);
  // The editor holds method, URL, headers, body, Send and a response; at the
  // default dock height only the first line shows, so the dock grows to fit.
  const openReplay = useCallback((id: string) => {
    const layout = useLayout.getState();
    if (layout.dockHeight < REPLAY_DOCK_HEIGHT) layout.setDockHeight(REPLAY_DOCK_HEIGHT);
    setReplaying(id);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The React Compiler is not in use here; the virtualizer's mutable instance is intended.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (i) => shown[i]?.id ?? i,
  });
  const items = virtualizer.getVirtualItems();
  // The table keeps its own layout; spacer rows stand in for everything scrolled out of view.
  const above = items[0]?.start ?? 0;
  const below = items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-2 pb-1 text-[11px] text-ink-3">
        <input
          aria-label="Filter requests"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          className="h-6 w-56 rounded-md border border-line bg-surface-2 px-2 text-[11px] text-ink outline-none placeholder:text-ink-3 focus:border-highlight/60"
        />
        <span>{rows.length} requests</span>
        <span>{size(transferred)} transferred</span>
        <label className="ml-auto flex items-center gap-1.5 text-ink-3 select-none">
          <input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} className="accent-highlight" />
          Preserve log
        </label>
      </div>
      <div ref={scrollRef} data-testid="network-scroll" className="min-h-16 flex-1 overflow-auto font-mono text-[11.5px] leading-5">
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
            {above > 0 && <tr aria-hidden style={{ height: above }} />}
            {items.map((v) => {
              const r = shown[v.index]!;
              return <NetworkRow key={r.id} row={r} index={v.index} selected={r.id === selected} onSelect={select} measure={virtualizer.measureElement} />;
            })}
            {below > 0 && <tr aria-hidden style={{ height: below }} />}
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
      {detail && replaying !== detail.id && activeTab && frames.length === 0 && <DetailPane tabId={activeTab} requestId={detail.id} />}
      {detail && replaying !== detail.id && (
        <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-ink-2 select-text">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-ink">{detail.method}</span> {detail.url}
            {detail.mimeType && <span className="ml-3 text-ink-3">{detail.mimeType}</span>}
            {detail.error && <span className="ml-3 text-danger">{detail.error}</span>}
          </span>
          <button type="button" onClick={() => { openReplay(detail.id); }} className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-line px-2 font-sans text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
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

/**
 * What the selected request sent and what came back: both header sets and
 * the bodies the engine kept. Read-only; Replay opens the editor.
 */
function DetailPane({ tabId, requestId }: { tabId: string; requestId: string }) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .requestDetail(tabId, requestId)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [tabId, requestId]);
  const notify = useBrowser((s) => s.notify);
  const copy = async (label: string, text: string) => {
    try {
      await copyText(text);
      notify(`${label} copied`);
    } catch (e) {
      notify(`Could not copy: ${errorMessage(e)}`, 4000);
    }
  };
  if (error) return <div className="border-t border-line px-3 py-2 font-mono text-[11px] text-ink-3">{error}</div>;
  if (!detail) return null;
  // A JSON body reads as JSON: laid out, not one long line.
  const body = detail.response_body ? prettyJson(detail.response_body) : (detail.response_body_note ?? (detail.status === null ? "No response yet." : "Body not kept: only JSON responses within the buffer budget are."));
  const chip = "flex h-5 items-center gap-1 rounded-full border border-line px-1.5 font-sans text-[10px] text-ink-2 hover:bg-surface-3 hover:text-ink";
  return (
    <div className="grid max-h-[50%] shrink-0 grid-cols-2 gap-x-4 overflow-auto border-t border-line px-3 py-2 font-mono text-[11px] leading-5 select-text" data-testid="request-detail">
      <section aria-label="Request">
        {detail.rewrites.length > 0 && (
          <p className="mb-1.5 rounded-md border border-highlight/30 bg-highlight/10 px-2 py-1 text-[11px] text-ink" data-testid="rule-effects">
            <span className="text-ink-3">Changed by a rule: </span>
            {detail.rewrites.join(" · ")}
            <span className="text-ink-3"> Headers below are as the page sent them.</span>
          </p>
        )}
        <div className="flex items-center gap-2">
          <h4 className="flex-1 text-[10px] tracking-wider text-ink-3 uppercase">Request headers</h4>
          <button type="button" onClick={() => void copy("cURL command", toCurl(detail))} className={chip} title="Copy this request as a cURL command">
            <Icon icon={Terminal} size={10} /> Copy as cURL
          </button>
        </div>
        <Headers headers={detail.request_headers} />
        {detail.request_body && (
          <>
            <h4 className="mt-2 text-[10px] tracking-wider text-ink-3 uppercase">Request body</h4>
            <pre className="whitespace-pre-wrap break-all text-ink-2">{detail.request_body}</pre>
          </>
        )}
      </section>
      <section aria-label="Response">
        <h4 className="text-[10px] tracking-wider text-ink-3 uppercase">Response headers</h4>
        <Headers headers={detail.response_headers} />
        <div className="mt-2 flex items-center gap-2">
          <h4 className="flex-1 text-[10px] tracking-wider text-ink-3 uppercase">Response body</h4>
          {detail.response_body && (
            <button type="button" onClick={() => void copy("Response body", body)} className={chip} title="Copy the response body">
              <Icon icon={Copy} size={10} /> Copy body
            </button>
          )}
        </div>
        <pre className={`whitespace-pre-wrap break-all ${detail.response_body ? "text-ink-2" : "text-ink-3"}`}>{body}</pre>
      </section>
    </div>
  );
}

function Headers({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <p className="text-ink-3">None recorded.</p>;
  return (
    <dl>
      {entries.map(([name, value]) => (
        <div key={name} className="flex gap-2">
          <dt className="shrink-0 text-ink-3">{name}:</dt>
          <dd className="min-w-0 break-all text-ink-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
