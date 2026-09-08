import { ArrowUpCircle, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { REPO_URL } from "../lib/constants";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { useUpdates } from "../store/updates";
import { Icon } from "./Icon";

/**
 * The card that appears when a newer release is ready: install now, or later.
 * It sits in the corner like a notice rather than covering the page, since
 * nothing about it is urgent.
 */
export function UpdateDialog() {
  const status = useUpdates((s) => s.status);
  const update = useUpdates((s) => s.update);
  const error = useUpdates((s) => s.error);
  const installing = useUpdates((s) => s.installing);
  const dismissed = useUpdates((s) => s.dismissed);
  const dismiss = useUpdates((s) => s.dismiss);
  const install = useUpdates((s) => s.install);
  const openTab = useBrowser((s) => s.openTab);

  const [exiting, setExiting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const visible = status === "available" && update !== null && !dismissed;

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      dismiss();
      setExiting(false);
    }, 150);
  }, [dismiss]);

  useFocusTrap(root, { active: visible, onEscape: handleDismiss });

  if (!visible || !update) return null;

  const versionString = update.version.startsWith("v") ? update.version : `v${update.version}`;

  return (
    <div
      ref={root}
      role="dialog"
      aria-labelledby="update-dialog-title"
      className={`surface-enter fixed right-4 bottom-4 z-50 w-[min(380px,calc(100vw-24px))] rounded-2xl border border-line-2 bg-surface/95 p-4 text-ink shadow-2xl backdrop-blur-xl transition-[opacity,transform] duration-150 ease-out ${
        exiting ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-highlight-soft text-highlight">
          <Icon icon={RefreshCw} size={16} />
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-highlight ring-2 ring-surface" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 id="update-dialog-title" className="text-sm font-semibold">
              Update available
            </h3>
            <span className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{versionString}</span>
          </div>
          <p className="mt-0.5 text-xs text-ink-3">A new build of Dive is ready. It installs in the background and restarts when you say.</p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss update"
          className="pressable grid size-6 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          <Icon icon={X} size={12} />
        </button>
      </div>

      {update.notes && (
        <div className="mt-3 rounded-xl border border-line bg-surface-2/70 px-3 py-2">
          <p className="text-[10.5px] font-medium tracking-[0.08em] text-ink-3 uppercase">What changed</p>
          <p className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed whitespace-pre-line text-ink-2">{update.notes}</p>
        </div>
      )}

      {error && (
        <div role="alert" className="mt-3 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {error}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
        <button
          type="button"
          onClick={() => void openTab(`${REPO_URL}/releases/tag/${versionString}`)}
          className="inline-flex items-center gap-1 rounded text-xs text-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-highlight"
        >
          Release notes
          <Icon icon={ExternalLink} size={11} />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={handleDismiss}
          disabled={installing}
          className="pressable h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        >
          Later
        </button>
        <button
          type="button"
          onClick={() => void install()}
          disabled={installing}
          className="pressable inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-xs font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
        >
          {installing ? (
            <>
              <Icon icon={Loader2} size={13} className="animate-spin" />
              Installing…
            </>
          ) : (
            <>
              <Icon icon={ArrowUpCircle} size={13} />
              Install and restart
            </>
          )}
        </button>
      </div>
    </div>
  );
}
