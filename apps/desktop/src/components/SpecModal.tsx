import { Check, Copy, Download, PlayCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { IconButton } from "./Icon";

/**
 * A generated Playwright test, ready to copy or save.
 *
 * Two things produce one: recording what the person did, and exporting what
 * the agent did. They are the same artefact and deserve the same window, so
 * the presentation lives here and each caller supplies the code and the
 * words around it.
 *
 * Mounted only while it is open, so covering the page is scoped to that.
 */
export function SpecModal({
  title,
  subtitle,
  spec,
  filename,
  onClose,
  footer,
}: {
  title: string;
  subtitle: string;
  spec: string;
  filename: string;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  useCoversContent(true);
  const root = useRef<HTMLDivElement>(null);
  useFocusTrap(root, { active: true });
  const { close, className } = useFadeClose(onClose);

  const handleCopy = async () => {
    try {
      await copyText(spec);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Nothing to say: the code is on screen and still selectable.
    }
  };

  const handleDownload = () => {
    const blob = new Blob([spec], { type: "text/typescript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-[60] grid place-items-center ${className}`} onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-native-overlay
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="flex h-[min(560px,85vh)] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
          <span className="grid size-6 place-items-center rounded-lg bg-highlight-soft text-highlight">
            <PlayCircle size={15} strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold text-ink">{title}</h2>
            <p className="truncate text-[11px] text-ink-3">{subtitle}</p>
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
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Generated Code</span>
            {footer}
          </div>
          <pre className="min-h-0 flex-1 select-text overflow-auto rounded-xl border border-line bg-surface-2 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
            <code>{spec}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
