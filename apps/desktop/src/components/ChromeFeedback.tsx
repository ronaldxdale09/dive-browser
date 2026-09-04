import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Icon } from "./Icon";

/** Lightweight loading shape used while a lazy panel chunk arrives. */
export function PanelSkeleton({ label, horizontal = false }: { label: string; horizontal?: boolean }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} className={`skeleton-enter min-h-0 bg-surface p-3 ${horizontal ? "h-full" : "w-full"}`}>
      <span className="sr-only">Loading {label}</span>
      <div className="mb-4 h-3 w-24 rounded-full bg-surface-3" />
      <div className="grid gap-2">
        <div className="h-8 rounded-lg bg-surface-2" />
        <div className="h-8 rounded-lg bg-surface-2/70" />
        {!horizontal && <div className="h-24 rounded-xl bg-surface-2/50" />}
      </div>
    </div>
  );
}

/** Notices stay clear of every dock and can be dismissed immediately. */
export function ToastViewport({ notice, error, onDismissNotice, onDismissError }: { notice: string | null; error: string | null; onDismissNotice: () => void; onDismissError: () => void }) {
  if (!notice && !error) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[80] flex w-[min(360px,calc(100vw-24px))] flex-col gap-2" aria-label="Notifications">
      {error && <Toast tone="danger" message={error} onDismiss={onDismissError} />}
      {notice && <Toast tone="success" message={notice} onDismiss={onDismissNotice} />}
    </div>
  );
}

function Toast({ tone, message, onDismiss }: { tone: "success" | "danger"; message: string; onDismiss: () => void }) {
  const danger = tone === "danger";
  return (
    <div role={danger ? "alert" : "status"} className={`surface-enter pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface/95 p-3 shadow-2xl backdrop-blur-xl ${danger ? "border-danger/45" : "border-line-2"}`}>
      <Icon icon={danger ? AlertTriangle : CheckCircle2} size={14} className={`mt-0.5 shrink-0 ${danger ? "text-danger" : "text-highlight"}`} />
      <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink-2">{message}</span>
      <button type="button" aria-label="Dismiss notification" onClick={onDismiss} className="pressable grid size-6 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink">
        <Icon icon={X} size={12} />
      </button>
    </div>
  );
}
