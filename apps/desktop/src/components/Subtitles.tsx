import { Captions } from "lucide-react";
import { useRef } from "react";
import { useBrowser } from "../store/browser";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { Icon } from "./Icon";
import { SubtitlesControls } from "./settings/SubtitlesControls";

/**
 * Turn on-device subtitles for the playing video: pick a local model, a
 * language, and whether to translate to English. The captions are drawn over
 * the page by the engine; this dialog only sets it going and shows that it is.
 * The controls are shared with the Settings section through the one store.
 */
export function Subtitles() {
  const open = useBrowser((s) => s.open.subtitles);
  const toggle = useBrowser((s) => s.toggle);
  useCoversContent(open);
  const root = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const { close, className } = useFadeClose(() => toggle("subtitles", false));
  useFocusTrap(root, { active: open, initialFocus: primary, onEscape: close });

  if (!open) return null;

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 ${className}`} onMouseDown={close}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Live subtitles"
        className="mx-auto mt-24 max-h-[calc(100dvh-8rem)] w-[420px] overflow-y-auto rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-ink-2">
            <Icon icon={Captions} size={16} />
          </span>
          <h2 className="min-w-0 text-sm font-semibold">Live subtitles</h2>
        </div>
        <SubtitlesControls onStarted={close} autoFocusPrimary={primary} />
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={close} className="h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-2">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
