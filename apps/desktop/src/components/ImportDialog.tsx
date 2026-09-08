import { Download } from "lucide-react";
import { useRef } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { useBrowserImport } from "../store/browserImport";
import { Icon } from "./Icon";
import { ImportPanel } from "./import/ImportPanel";

/**
 * Bring bookmarks and history in from another browser, any time after
 * setup: from the default-browser offer, Settings, or the palette.
 * `preferBrowser` in the import store picks the row to start on.
 */
export function ImportDialog() {
  const toggle = useBrowser((s) => s.toggle);
  const prefer = useBrowserImport((s) => s.preferBrowser);
  const reset = useBrowserImport((s) => s.reset);
  useCoversContent(true);
  const root = useRef<HTMLDivElement>(null);
  const { close, className } = useFadeClose(() => {
    reset();
    toggle("import", false);
  });
  useFocusTrap(root, { onEscape: close });
  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 ${className}`} onMouseDown={close}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Import from another browser"
        className="mx-auto mt-24 w-[480px] max-w-[92vw] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-ink-2">
            <Icon icon={Download} size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Import from another browser</h2>
            <p className="text-[11px] text-ink-3">Bookmarks, history, passwords and form entries from a browser on this Mac.</p>
          </div>
        </div>
        <div className="mt-4">
          <ImportPanel prefer={prefer} compact />
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={close} className="h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-2">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
