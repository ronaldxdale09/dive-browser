import { ChevronRight, ExternalLink, Locate, Play } from "lucide-react";
import { useState } from "react";
import { ipc } from "../lib/ipc";
import type { A11yReport } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { errorMessage } from "../lib/errors";
import { InternalPageNote, isInternalPage } from "./InternalPageNote";

const IMPACT: Record<string, string> = {
  critical: "text-danger",
  serious: "text-danger",
  moderate: "text-warn",
  minor: "text-ink-2",
};

/** Runs axe-core in the page on demand and lists violations. */
export function A11yPanel() {
  const activeTab = useBrowser((s) => s.activeTab);
  const url = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab)?.url);
  const openTab = useBrowser((s) => s.openTab);
  const [missing, setMissing] = useState<string | null>(null);
  // One report per tab, so switching tabs never shows another page's
  // findings, and switching back keeps the ones already gathered.
  const [reports, setReports] = useState<Record<string, A11yReport>>({});
  const report = activeTab ? (reports[activeTab] ?? null) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!activeTab) return;
    setBusy(true);
    setError(null);
    setMissing(null);
    try {
      const { default: axeSource } = await import("axe-core/axe.min.js?raw");
      const next = await ipc.tabA11y(activeTab, axeSource);
      setReports((all) => ({ ...all, [activeTab]: next }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Scroll the page to the offending element and flash it. A selector that
  // no longer matches (the page changed) is reported instead of ignored.
  const reveal = async (selector: string) => {
    if (!activeTab) return;
    try {
      setMissing((await ipc.tabA11yReveal(activeTab, selector)) ? null : selector);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (isInternalPage(url)) return <InternalPageNote what="accessibility audits" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-2 pb-1 text-[11px] text-ink-3">
        <button
          type="button"
          disabled={!activeTab || busy}
          onClick={() => void run()}
          className="flex h-6 items-center gap-1.5 rounded-full bg-accent px-2.5 text-[11px] font-medium text-accent-ink disabled:opacity-40"
        >
          <Icon icon={Play} size={11} /> {busy ? "Running…" : "Run audit"}
        </button>
        {report && (
          <span role="status">
            {report.violations.length} {report.violations.length === 1 ? "violation" : "violations"} · {report.passes} passed · {report.incomplete} to review
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-1 text-xs select-text">
        {error && (
          <div role="alert" className="py-2 text-danger">
            {error}
          </div>
        )}
        {!report && !error && <div className="py-2 text-ink-3">{activeTab ? "Run axe-core against the current page." : "Open a tab to audit it."}</div>}
        {report?.violations.length === 0 && <div className="py-2 text-ink-2">No violations found.</div>}
        {report?.violations.map((v) => (
          <details key={v.id} className="group border-b border-line/60 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded hover:bg-surface-2" title="Show the elements">
              <Icon icon={ChevronRight} size={11} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
              <span className={`w-16 shrink-0 font-mono text-[10px] uppercase ${IMPACT[v.impact] ?? "text-ink-2"}`}>{v.impact}</span>
              <span className="flex-1 text-ink">{v.help}</span>
              <span className="font-mono text-[10px] text-ink-3">{v.count}×</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  void openTab(v.help_url);
                }}
                className="rounded text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-highlight"
                aria-label={`Docs for ${v.id}`}
                title="Open the rule's documentation in a new tab"
              >
                <Icon icon={ExternalLink} size={11} />
              </button>
            </summary>
            <ul className="mt-1 ml-[88px] text-[11px] text-ink-2">
              {v.targets.map((t, i) => (
                <li key={t} className="py-0.5">
                  <button
                    type="button"
                    onClick={() => void reveal(t)}
                    className="flex max-w-full items-center gap-1.5 rounded font-mono text-ink-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-highlight"
                    aria-label={`Show ${t} in the page`}
                    title="Scroll the page to this element"
                  >
                    <Icon icon={Locate} size={11} className="shrink-0 text-ink-3" />
                    <span className="truncate">{t}</span>
                  </button>
                  {missing === t && <p className="mt-0.5 text-[10.5px] text-warn">Not on the page any more. Run the audit again.</p>}
                  {v.notes[i] && <p className="mt-0.5 whitespace-pre-line text-[10.5px] leading-snug text-ink-3">{v.notes[i]}</p>}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}
