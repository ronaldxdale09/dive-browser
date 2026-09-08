import { Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { useFocusTrap } from "../lib/useFocusTrap";
import type { ReplayRequestInput, ReplayResponse } from "../lib/ipc";
import { Icon, IconButton } from "./Icon";
import { errorMessage } from "../lib/errors";

function headersToText(h: Record<string, string>) {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** Parse `Name: value` lines; blank lines and lines without a colon are skipped. */
export function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Edit and resend a captured request; shows the response inline. */
export function ReplayEditor({ tabId, requestId, onClose }: { tabId: string; requestId: string; onClose: () => void }) {
  const [draft, setDraft] = useState<ReplayRequestInput | null>(null);
  const [headersText, setHeadersText] = useState("");
  const [response, setResponse] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog, { onEscape: onClose });

  useEffect(() => {
    let alive = true;
    ipc
      .requestCaptured(tabId, requestId)
      .then((r) => {
        if (!alive) return;
        setDraft(r);
        setHeadersText(headersToText(r.headers));
      })
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [tabId, requestId]);

  const send = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      setResponse(await ipc.requestReplay(tabId, { ...draft, headers: textToHeaders(headersText) }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-highlight/60";
  return (
    <div ref={dialog} role="dialog" aria-label="Replay request" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto border-t border-line bg-surface-2 p-2 text-xs select-text">
      <div className="flex items-center gap-2">
        <span className="text-[10px] tracking-wider text-ink-3 uppercase">Replay</span>
        <span className="flex-1" />
        <IconButton icon={X} label="Close replay" size={12} onClick={onClose} />
      </div>
      {error && <div role="alert" className="text-danger">{error}</div>}
      {draft && (
        <>
          <div className="flex gap-2">
            <input aria-label="Method" value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value.toUpperCase() })} className={`${field} w-24`} />
            <input aria-label="URL" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} className={field} />
          </div>
          <textarea aria-label="Headers" value={headersText} onChange={(e) => setHeadersText(e.target.value)} rows={4} placeholder="Name: value" className={`${field} resize-y`} />
          <textarea aria-label="Body" value={draft.body ?? ""} onChange={(e) => setDraft({ ...draft, body: e.target.value || null })} rows={3} placeholder="Body" className={`${field} resize-y`} />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-ink-2">
              <input type="checkbox" checked={draft.with_cookies} onChange={(e) => setDraft({ ...draft, with_cookies: e.target.checked })} className="accent-highlight" />
              Send this tab's cookies
            </label>
            {draft.with_cookies && !draft.url.includes(`//${draft.captured_host}`) && <span className="text-[11px] text-warn">cookies only go to {draft.captured_host}</span>}
            <span className="flex-1" />
            <button type="button" disabled={busy} onClick={() => void send()} className="flex h-7 items-center gap-1.5 rounded-full bg-accent px-3 text-[11px] font-medium text-accent-ink disabled:opacity-40">
              <Icon icon={Play} size={11} /> {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </>
      )}
      {response && (
        <div className="rounded-lg border border-line bg-surface p-2">
          <div className="mb-1 flex items-center gap-3 font-mono text-[11px]">
            <span className={response.status >= 400 ? "text-danger" : response.status >= 300 ? "text-warn" : "text-good"}>{response.status}</span>
            <span className="text-ink-3">{response.elapsed_ms} ms</span>
          </div>
          <details className="mb-1">
            <summary className="cursor-default text-[11px] text-ink-3">{Object.keys(response.headers).length} response headers</summary>
            <pre className="mt-1 max-h-32 overflow-auto font-mono text-[10.5px] text-ink-2">{headersToText(response.headers)}</pre>
          </details>
          <pre className="max-h-64 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap text-ink">{response.body || "(empty body)"}</pre>
        </div>
      )}
    </div>
  );
}
