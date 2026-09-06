import { Film } from "lucide-react";
import { Icon } from "../components/Icon";
import { IMPORT_BUSY, useImportVideo } from "./importVideo";

/** The shared "Open Video…" affordance: one look everywhere, one busy state. */
export function OpenVideoButton({ onOpened, className }: { onOpened?: () => void; className?: string }) {
  const busy = useImportVideo((s) => s.busy);
  const open = useImportVideo((s) => s.open);
  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={busy}
      title={busy ? IMPORT_BUSY : "Open an MP4, MOV, WebM, MKV or GIF in DiveScreen"}
      onClick={() => void open(onOpened)}
      className={className ?? "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-60"}
    >
      <Icon icon={Film} size={14} />
      {busy ? "Importing video…" : "Open Video…"}
    </button>
  );
}
