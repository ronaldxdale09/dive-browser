import { useRef } from "react";
import { Icon } from "./Icon";
import { AppWindow } from "lucide-react";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { originOf, useWebApps } from "../store/webapps";
import type { WebAppProbe } from "../lib/ipc";

/**
 * "Install app": the manifest's icon, name and origin, and one decision.
 * Installing moves this tab into the app's own window, the way Chrome does,
 * so the page you were looking at is the app you just installed.
 */
export function InstallAppDialog({ tabId, probe, onClose }: { tabId: string; probe: WebAppProbe; onClose: () => void }) {
  const installing = useWebApps((s) => s.installing);
  const error = useWebApps((s) => s.error);
  const install = useWebApps((s) => s.install);
  useCoversContent(true);
  const root = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const { close, className } = useFadeClose(onClose);
  useFocusTrap(root, { active: true, initialFocus: primary, onEscape: close });
  const name = probe.name ?? "";
  const origin = originOf(probe.start_url ?? "");

  return (
    <div className={`overlay-backdrop fixed inset-0 z-50 grid place-items-center ${className}`} onMouseDown={close}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-app-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[420px] max-w-[92vw] overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <div className="px-5 pt-5 pb-4">
          <h2 id="install-app-title" className="text-[15px] font-medium text-ink">Install app</h2>
          <div className="mt-4 flex items-center gap-3.5">
            {probe.icon_url ? (
              <img src={probe.icon_url} alt="" width={48} height={48} className="size-12 shrink-0 rounded-xl bg-surface-2 object-contain" />
            ) : (
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-3"><Icon icon={AppWindow} size={22} /></span>
            )}
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">{name}</p>
              <p className="truncate text-xs text-ink-3">{origin}</p>
            </div>
          </div>
          {probe.description && <p className="mt-3 line-clamp-2 text-xs text-ink-2">{probe.description}</p>}
          <p className="mt-3 text-xs text-ink-3">Opens in its own window and appears in Spotlight. Signed in as you are now.</p>
          {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-4 py-3">
          <button type="button" onClick={close} className="rounded-full border border-line-2 px-4 py-1.5 text-xs text-ink hover:bg-surface-3">Cancel</button>
          <button
            ref={primary}
            type="button"
            disabled={installing}
            // Success skips the fade: the tab has just become the app's
            // window, so this window no longer shows the page the dialog was
            // about, and the parent unmounts the dialog on its own.
            onClick={() => void install(tabId).then((app) => { if (app) onClose(); })}
            className="rounded-full bg-highlight px-4 py-1.5 text-xs font-medium text-ground hover:opacity-90 disabled:opacity-60"
          >
            {installing ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}
