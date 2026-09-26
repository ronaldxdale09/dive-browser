import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { announce, clearAnnouncement, currentAnnouncements, subscribeAnnouncements } from "../lib/announce";
import type { Announcement, Urgency } from "../lib/announce";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { holdNotice } from "../store/browser";
import type { NoticeAction } from "../store/browser";
import { Icon } from "./Icon";

/** How long a message stays in its region after it was said. */
const SPOKEN_MS = 10_000;

/**
 * The chrome's two live regions, mounted once with the chrome and never
 * taken away, so everything `announce` writes is a change to a region that
 * was already there. Each message is a new node: the same words twice (two
 * "Copied the address") are still two announcements.
 */
export function LiveRegions() {
  const regions = useSyncExternalStore(subscribeAnnouncements, currentAnnouncements);
  return (
    <div className="sr-only">
      <div role="status" aria-live="polite" aria-atomic="true" data-live-region="polite">
        <Spoken urgency="polite" message={regions.polite} />
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" data-live-region="assertive">
        <Spoken urgency="assertive" message={regions.assertive} />
      </div>
    </div>
  );
}

function Spoken({ urgency, message }: { urgency: Urgency; message: Announcement | null }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => clearAnnouncement(urgency, message.id), SPOKEN_MS);
    return () => clearTimeout(timer);
  }, [urgency, message]);
  return message ? <span key={message.id}>{message.text}</span> : null;
}

/** Keep a slow lazy import visible, keyboard accessible, and cancellable. */
export function DialogLoading({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useCoversContent(true);
  useFocusTrap(root, { onEscape: onClose });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div ref={root} role="dialog" aria-modal="true" aria-label="Loading dialog" className="w-72 rounded-2xl border border-line-2 bg-surface p-5 shadow-2xl">
        <p role="status" className="text-sm text-ink">Opening dialog…</p>
        <button type="button" onClick={onClose} className="mt-4 rounded-full border border-line-2 px-4 py-1.5 text-xs text-ink hover:bg-surface-2">Cancel</button>
      </div>
    </div>
  );
}

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
export function ToastViewport({
  notice,
  noticeAction = null,
  error,
  onDismissNotice,
  onDismissError,
}: {
  notice: string | null;
  noticeAction?: NoticeAction | null;
  error: string | null;
  onDismissNotice: () => void;
  onDismissError: () => void;
}) {
  // Notices hang from the chrome at the top right, below the toolbar they
  // belong to and clear of the agent at the bottom of the window. They sit
  // over the page's own rectangle, and a native page paints above the chrome,
  // so without a region the toast is drawn behind it -- which took every
  // error message, "Saved ..." and the Undo on "Closed N tabs" with it.
  useCoversContent(Boolean(notice || error));
  // Said through the chrome's standing regions rather than by the toast: a
  // toast is a region that arrives with its own text, which most screen
  // readers never speak. An action is named, so a reader knows there is
  // something to reach for; F6 goes to it.
  useEffect(() => {
    if (notice) announce(noticeAction ? `${notice}. ${noticeAction.label} is in the notification.` : notice);
  }, [notice, noticeAction]);
  useEffect(() => {
    if (error) announce(error, "assertive");
  }, [error]);
  if (!notice && !error) return null;
  return (
    <div className="pointer-events-none fixed top-[calc(var(--chrome-top,86px)+8px)] right-4 z-[80] flex w-[min(360px,calc(100vw-24px))] flex-col gap-2" data-pane="notice">
      {error && <Toast tone="danger" message={error} onDismiss={onDismissError} />}
      {notice && <Toast tone="success" message={notice} action={noticeAction} onDismiss={onDismissNotice} holds />}
    </div>
  );
}

function Toast({
  tone,
  message,
  action = null,
  onDismiss,
  holds = false,
}: {
  tone: "success" | "danger";
  message: string;
  action?: NoticeAction | null;
  onDismiss: () => void;
  /** The pointer or focus on it keeps the notice from timing out. */
  holds?: boolean;
}) {
  const danger = tone === "danger";
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = holds && (hovered || focused);
  useEffect(() => {
    if (holds) holdNotice(held);
  }, [holds, held]);
  // A toast that goes while held (dismissed, or replaced) lets go, or the
  // next notice would wait for a pointer that is no longer over anything.
  useEffect(() => (holds ? () => holdNotice(false) : undefined), [holds]);
  return (
    <div
      data-native-overlay
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={`surface-enter pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface/95 p-3 shadow-2xl backdrop-blur-xl ${danger ? "border-danger/45" : "border-line-2"}`}
    >
      <Icon icon={danger ? AlertTriangle : CheckCircle2} size={14} className={`mt-0.5 shrink-0 ${danger ? "text-danger" : "text-highlight"}`} />
      <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink-2">{message}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.run();
            onDismiss();
          }}
          className="pressable h-6 shrink-0 rounded-full border border-line-2 px-2.5 text-[11px] font-medium text-ink hover:bg-surface-3"
        >
          {action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss notification" onClick={onDismiss} className="pressable grid size-6 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink">
        <Icon icon={X} size={12} />
      </button>
    </div>
  );
}
