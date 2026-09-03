import { Check, Copy, Download, PlayCircle, X } from "lucide-react";
import { useRef, useState } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { recordedToSteps, toPlaywrightSpec } from "../lib/playwright";
import { useBrowser } from "../store/browser";
import { useRecorder } from "../store/recorder";
import { IconButton } from "./Icon";

export function RecorderModal() {
  const isOpen = useRecorder((s) => s.isOpen);
  const setOpen = useRecorder((s) => s.setOpen);
  const steps = useRecorder((s) => s.steps);
  const clear = useRecorder((s) => s.clear);
  const tabs = useBrowser((s) => s.tabs);
  const activeTabId = useBrowser((s) => s.activeTab);
  const [copied, setCopied] = useState(false);
  // Mounted unconditionally by App, so this must follow `isOpen`: covering
  // while closed would hide the page for the life of the app.
  useCoversContent(isOpen);
  const root = useRef<HTMLDivElement>(null);
  useFocusTrap(root, { active: isOpen });
  const { close, className } = useFadeClose(() => setOpen(false));

  if (!isOpen) return null;

  const currentTab = tabs.find((t) => t.id === activeTabId);
  const startUrl = currentTab?.url || "https://example.com";
  const title = currentTab?.title ? `flow on ${currentTab.title}` : "recorded flow";
  const spec = toPlaywrightSpec(recordedToSteps(steps), startUrl, title);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(spec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleDownload = () => {
    const blob = new Blob([spec], { type: "text/typescript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recorded.spec.ts";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      ref={root}
      className={`fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-[2px] ${className}`}
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recorded Test"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="flex h-[min(560px,85vh)] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
          <span className="grid size-6 place-items-center rounded-lg bg-highlight-soft text-highlight">
            <PlayCircle size={15} strokeWidth={2} aria-hidden />
          </span>
          <div>
            <h2 className="text-xs font-semibold text-ink">Recorded Playwright Test</h2>
            <p className="text-[11px] text-ink-3">{steps.length} interaction{steps.length === 1 ? "" : "s"} captured</p>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 text-xs font-medium text-ink transition-colors hover:bg-surface-3"
          >
            {copied ? <Check size={13} className="text-highlight" /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy Spec"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 text-xs font-medium text-ink transition-colors hover:bg-surface-3"
          >
            <Download size={13} />
            Download .spec.ts
          </button>
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
          <IconButton icon={X} label="Close" size={15} onClick={close} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col bg-ground p-4">
          <div className="flex items-center justify-between pb-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-3">
              Generated Code
            </span>
            <button
              type="button"
              onClick={clear}
              className="text-[11px] text-ink-3 hover:text-ink hover:underline"
            >
              Clear Steps
            </button>
          </div>
          <pre className="min-h-0 flex-1 select-text overflow-auto rounded-xl border border-line bg-surface-2 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
            <code>{spec}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
