import { Download } from "lucide-react";
import { importFromWhere } from "../lib/commands";
import { useBrowser } from "../store/browser";
import { useBrowserImport } from "../store/browserImport";
import { Icon } from "./Icon";
import { Modal, useModalClose } from "./Modal";
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
  return (
    <Modal
      label="Import from another browser"
      backdropClassName=""
      onClose={() => {
        reset();
        toggle("import", false);
      }}
      className="mx-auto mt-24 w-[480px] max-w-[92vw] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
    >
      <ImportBody prefer={prefer} />
    </Modal>
  );
}

function ImportBody({ prefer }: { prefer: ReturnType<typeof useBrowserImport.getState>["preferBrowser"] }) {
  const close = useModalClose();
  return (
    <>
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-ink-2">
            <Icon icon={Download} size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Import from another browser</h2>
            <p className="text-11 text-ink-3">Bookmarks, history, passwords and form entries from {importFromWhere()}.</p>
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
    </>
  );
}
