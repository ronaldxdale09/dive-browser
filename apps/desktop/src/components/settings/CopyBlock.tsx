import { Check as CheckIcon, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../Icon";
import { copyText } from "../../lib/clipboard";

/**
 * A read-only command with a copy button. `display` is what the block shows
 * when the full text is too long or sensitive to show; the clipboard always gets `text`.
 * Supply `displayTitle` only for a safe, intentionally visible hover preview.
 */
export function CopyBlock({ text, label = "Copy command", display, displayTitle }: { text: string; label?: string; display?: ReactNode; displayTitle?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2">
      <code title={displayTitle} className="min-w-0 flex-1 font-mono text-[11px] break-all text-ink select-text">
        {display ?? (text || "…")}
      </code>
      {copied && (
        <span role="status" className="sr-only">
          Copied to the clipboard
        </span>
      )}
      <button
        type="button"
        aria-label={copied ? "Copied" : label}
        title={copied ? "Copied" : label}
        disabled={!text}
        onClick={() => {
          void copyText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="grid size-6 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink"
      >
        <Icon icon={copied ? CheckIcon : Copy} size={12} />
      </button>
    </div>
  );
}
