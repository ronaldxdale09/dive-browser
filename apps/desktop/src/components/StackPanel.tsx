import { Boxes, Info, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Category, Detection, StackReport } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { errorMessage } from "../lib/errors";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { InternalPageNote, isInternalPage } from "./InternalPageNote";

/** Reading order: what it is built with, then what runs it, then what watches it. */
const ORDER: { id: Category; label: string }[] = [
  { id: "framework", label: "Framework" },
  { id: "ui", label: "UI & state" },
  { id: "build", label: "Build" },
  { id: "server", label: "Server" },
  { id: "hosting", label: "Hosting & CDN" },
  { id: "platform", label: "Platform" },
  { id: "analytics", label: "Analytics & services" },
];

/**
 * What the page is built with, from the traffic Dive already has plus the
 * page's own version properties. Nothing is sent anywhere: the detection is
 * the browser reading its own request log, which is the whole reason to have
 * this built in rather than as an extension.
 */
export function StackPanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const url = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab)?.url ?? "");
  // Keyed by tab *and* URL: a reading belongs to the page it was taken on,
  // so navigating away drops it without an effect that clears state.
  const [reports, setReports] = useState<Record<string, StackReport>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${activeTab ?? ""}\u0000${url}`;
  const report = reports[key];

  const scan = useCallback(async () => {
    if (!activeTab) return;
    setBusy(true);
    setError(null);
    try {
      const found = await ipc.tabStack(activeTab);
      setReports((r) => ({ ...r, [key]: found }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [activeTab, key]);

  if (isInternalPage(url)) return <InternalPageNote what="A stack" />;

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy || !activeTab}
          className="flex h-7 items-center gap-1.5 rounded-lg border border-line-2 px-2.5 text-[11px] text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          <Icon icon={RefreshCw} size={12} className={busy ? "animate-spin" : undefined} />
          {report ? "Scan again" : "Detect stack"}
        </button>
        {report && (
          <span className="text-[11px] text-ink-3">
            {report.technologies.length} found
            {report.server_rendered && " · server-rendered"}
          </span>
        )}
        <Tooltip label="Detected from response headers, cookies, request paths and the page's own version properties. Nothing leaves this machine." side="bottom">
          <span className="ml-auto grid size-6 place-items-center text-ink-3"><Icon icon={Info} size={12} /></span>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p role="alert" className="text-danger">{error}</p>}
        {!report && !error && (
          <p className="px-1 py-6 text-center text-ink-3">
            {busy ? "Reading the page…" : "Detect what this page is built with."}
          </p>
        )}
        {report && report.technologies.length === 0 && (
          <p className="px-1 py-6 text-center text-ink-3">Nothing recognised on this page.</p>
        )}
        {report && (
          <div className="flex flex-col gap-3">
            {ORDER.map(({ id, label }) => {
              const found = report.technologies.filter((t) => t.category === id);
              if (found.length === 0) return null;
              return (
                <section key={id}>
                  <h3 className="mb-1 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">{label}</h3>
                  <div className="flex flex-col gap-0.5">
                    {found.map((t) => <Row key={t.name} tech={t} />)}
                  </div>
                </section>
              );
            })}
            {report.generator && (
              <section>
                <h3 className="mb-1 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">Generator</h3>
                <p className="px-2 font-mono text-[11px] text-ink-2">{report.generator}</p>
              </section>
            )}
            {report.packages.length > 0 && (
              <section>
                <h3 className="mb-1 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">
                  From source maps · {report.packages.length} packages
                </h3>
                <p className="mb-1.5 px-2 text-[11px] text-ink-3">
                  Real dependencies named by the page's own bundles, not guessed from filenames.
                </p>
                <div className="flex flex-wrap gap-1 px-2">
                  {report.packages.map((p) => (
                    <span key={p} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{p}</span>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ tech }: { tech: Detection }) {
  return (
    <Tooltip label={tech.evidence.join(" · ") || "no evidence recorded"} side="bottom" align="start">
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
        <Icon icon={Boxes} size={12} className="shrink-0 text-ink-3" />
        <span className="truncate text-ink">{tech.name}</span>
        {tech.version && (
          <span className="shrink-0 rounded bg-highlight-soft px-1 font-mono text-[10px] text-highlight">{tech.version}</span>
        )}
        <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-ink-3">{tech.evidence[0] ?? ""}</span>
      </div>
    </Tooltip>
  );
}
