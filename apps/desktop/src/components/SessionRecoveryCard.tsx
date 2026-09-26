import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errors";
import { ipc } from "../lib/ipc";
import type { SessionRecovery } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { isPrivateWindow } from "../lib/privateMode";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";

/**
 * After Dive has quit unexpectedly twice in a row, the host starts with the
 * session's tabs asleep rather than loading the one it ended on again --
 * the likeliest cause -- and this card asks what to do. The host holds the
 * question, so a chrome that mounts late still sees it.
 */
export function SessionRecoveryCard() {
  const [recovery, setRecovery] = useState<SessionRecovery | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isPrivateWindow()) return;
    let live = true;
    ipc
      .sessionRecoveryStatus()
      .then((found) => {
        if (live) setRecovery(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useCoversContent(recovery !== null);
  if (!recovery) return null;

  const answer = async (restore: boolean) => {
    setBusy(true);
    try {
      await ipc.sessionRecoveryResolve(restore);
      setRecovery(null);
    } catch (e) {
      setBusy(false);
      useBrowser.getState().notify(`Could not restore the tabs: ${errorMessage(e)}`, 6000);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="session-recovery-title"
      aria-describedby="session-recovery-text"
      className="surface-enter fixed top-[calc(var(--chrome-top,86px)+8px)] left-1/2 z-50 w-[min(400px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl border border-line-2 bg-surface/95 p-4 text-ink shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-danger">
          <Icon icon={AlertTriangle} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="session-recovery-title" className="text-sm font-semibold">
            Dive quit unexpectedly
          </h3>
          <p id="session-recovery-text" className="mt-0.5 text-xs text-ink-3">
            It did not close properly the last {recovery.crashes} times, so your tabs were left asleep in case one of them caused it.
            {recovery.can_restore ? " Restore them, or start fresh and open them one at a time." : " They are still in the tab strip."}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3">
        <button type="button" disabled={busy} onClick={() => void answer(false)} className="pressable h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-2 disabled:opacity-50">
          {recovery.can_restore ? "Start fresh" : "OK"}
        </button>
        {recovery.can_restore && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(true)}
            className="pressable inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-xs font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
          >
            Restore tabs
          </button>
        )}
      </div>
    </div>
  );
}
