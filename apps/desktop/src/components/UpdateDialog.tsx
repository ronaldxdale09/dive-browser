import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { useUpdates } from "../store/updates";
import { useFocusTrap } from "../lib/useFocusTrap";
import { REPO_URL } from "../lib/constants";

export function UpdateDialog() {
  const status = useUpdates((s) => s.status);
  const update = useUpdates((s) => s.update);
  const error = useUpdates((s) => s.error);
  const installing = useUpdates((s) => s.installing);
  const dismissed = useUpdates((s) => s.dismissed);
  const dismiss = useUpdates((s) => s.dismiss);
  const install = useUpdates((s) => s.install);

  const [exiting, setExiting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const visible = status === "available" && update !== null && !dismissed;
  useFocusTrap(root, { active: visible });

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      dismiss();
      setExiting(false);
    }, 150);
  }, [dismiss]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && status === "available" && !dismissed) {
        handleDismiss();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [status, dismissed, handleDismiss]);

  if (!visible || !update) {
    return null;
  }

  const versionString = update.version.startsWith("v") ? update.version : `v${update.version}`;

  return (
    <div
      ref={root}
      role="dialog"
      aria-labelledby="update-dialog-title"
      className={`fixed bottom-5 right-5 z-50 w-96 max-w-[calc(100vw-40px)] rounded-2xl border border-dive-accent/30 bg-elevated/95 p-4 text-ink shadow-2xl shadow-black/70 backdrop-blur-xl transition-all duration-200 ease-out ${
        exiting
          ? "translate-y-4 scale-95 opacity-0 pointer-events-none"
          : "translate-y-0 scale-100 opacity-100 animate-in fade-in slide-in-from-bottom-4"
      }`}
    >
      {/* Top Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-dive-accent/25 bg-dive-accent/15 text-dive-accent">
            <RefreshCw className="h-4 w-4" />
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-dive-accent opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-dive-accent" />
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 id="update-dialog-title" className="text-sm font-semibold tracking-tight text-ink">
                Update Available
              </h3>
              <span className="rounded bg-dive-accent/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-dive-accent">
                {versionString}
              </span>
            </div>
            <p className="text-xs text-ink-muted">A new build of Dive Browser is ready.</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-lg p-1 text-ink-subtle hover:bg-fill-muted hover:text-ink transition-colors"
          aria-label="Dismiss update"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Release Notes / Highlights if available */}
      {update.notes && (
        <div className="mt-3 rounded-lg border border-line/70 bg-ground/60 p-2.5 text-xs text-ink-muted">
          <p className="font-medium text-ink text-[11px] uppercase tracking-wider mb-1">Release Highlights</p>
          <div className="line-clamp-3 leading-relaxed whitespace-pre-line text-[11px]">
            {update.notes}
          </div>
        </div>
      )}

      {/* Error state if installation failed */}
      {error && (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Action Footer */}
      <div className="mt-4 flex items-center justify-between gap-2 pt-1 border-t border-line/40">
        <a
          href={`${REPO_URL}/releases/tag/${versionString}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-ink-subtle hover:text-dive-accent transition-colors"
        >
          <span>Changelog</span>
          <ExternalLink className="h-3 w-3" />
        </a>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={installing}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-fill-muted hover:text-ink transition-colors disabled:opacity-50"
          >
            Later
          </button>

          <button
            type="button"
            onClick={() => void install()}
            disabled={installing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-dive-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:brightness-110 active:brightness-95 transition-all disabled:opacity-50"
          >
            {installing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Updating...</span>
              </>
            ) : (
              <>
                <ArrowUpCircle className="h-3.5 w-3.5" />
                <span>Install & Restart</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
