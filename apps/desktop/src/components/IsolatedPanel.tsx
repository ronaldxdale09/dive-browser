import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

type Props = { label: string; modal?: boolean; onClose: () => void; children: ReactNode };

/** Mount only while open. The cover survives both a failed child and lazy loading. */
export function IsolatedPanel({ label, modal = false, onClose, children }: Props) {
  useCoversContent(modal);
  return <PanelErrorBoundary label={label} fallback={<Unavailable label={label} modal={modal} onClose={onClose} />}>{children}</PanelErrorBoundary>;
}

function Unavailable({ label, modal, onClose }: Omit<Props, "children">) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useFocusTrap(root, { active: modal, onEscape: onClose });
  useEffect(() => {
    // Inline tools must leave a focused address bar or another panel alone.
    if (!modal && document.activeElement === document.body) close.current?.focus({ preventScroll: true });
  }, [modal]);
  const contents = <><p role="alert">{label} is unavailable. You can keep browsing.</p><button ref={close} type="button" onClick={onClose} aria-label={`Close ${label}`} className="mt-3 min-h-9 rounded-lg border border-line-2 px-3 text-sm text-ink hover:bg-surface-3">Close</button></>;
  return modal ? <div ref={root} className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-[2px]">
    <div role="dialog" aria-modal="true" aria-label={`${label} unavailable`} className="w-full max-w-sm rounded-2xl border border-line-2 bg-surface p-5 text-sm text-ink-2 shadow-2xl">{contents}</div>
  </div> : <div className="grid h-full min-h-0 min-w-0 place-content-center overflow-auto bg-surface p-4 text-sm text-ink-2">{contents}</div>;
}
