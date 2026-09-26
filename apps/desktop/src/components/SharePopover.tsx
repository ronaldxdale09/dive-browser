import { Check, Copy, Share } from "lucide-react";
import { OPEN_SHARE } from "../lib/commands";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { ShareInfo } from "../lib/ipc";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { errorMessage } from "../lib/errors";
import { copyText } from "../lib/clipboard";
import { useDismiss } from "../lib/useDismiss";

/** Share button: the current URL rewritten to this machine's LAN address, as a QR code. */
export function SharePopover() {
  const current = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? s.tabs.find((t) => t.id === id) : undefined;
  });
  const [open, setOpen] = useState(false);
  // The code is kept with the address it was made for, so a QR for the last
  // page is never shown for this one while the new one is being made.
  const [shared, setShared] = useState<{ url: string; info: ShareInfo } | null>(null);
  const url = current?.url;
  const info = shared && shared.url === url ? shared.info : null;
  // A failure, too, belongs to the address it was about.
  const [failure, setFailure] = useState<{ url: string | undefined; message: string } | null>(null);
  const error = failure && failure.url === url ? failure.message : null;
  const setError = (message: string | null) => setFailure(message === null ? null : { url, message });
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open });
  // A click on the page never reaches the chrome as a mousedown, only as the
  // window losing focus; useDismiss closes on that too.
  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, dismiss);

  // The page's right-click menu asks for the QR code through the host.
  useEffect(() => {
    const show = () => {
      if (!current) return;
      setShared(null);
      setFailure(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_SHARE, show);
    return () => window.removeEventListener(OPEN_SHARE, show);
  }, [current]);

  // Keyed on the address, not the tab object: a title or favicon change must
  // not ask again, and a navigation while open must.
  useEffect(() => {
    if (!open || url === undefined) return;
    let alive = true;
    ipc
      .shareUrl(url)
      .then((i) => alive && (setShared({ url, info: i }), setFailure(null)))
      .catch((e: unknown) => alive && setFailure({ url, message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [open, url]);

  return (
    <div ref={ref} className="relative">
      <Tooltip label="Share to another device" side="bottom">
        <button
          type="button"
          aria-label="Share to another device"
          aria-expanded={open}
          disabled={!current}
          onClick={() => {
            // Each opening makes a fresh code: the LAN address can change
            // between openings (another network, a new DHCP lease).
            if (!open) {
              setShared(null);
              setFailure(null);
            }
            setOpen(!open);
          }}
          className="grid size-7 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35"
        >
          <Icon icon={Share} />
        </button>
      </Tooltip>
      {open && (
        <div ref={panel} role="dialog" aria-label="Share" className="absolute right-0 z-40 mt-1 w-64 rounded-xl border border-line-2 bg-surface p-3 text-xs shadow-2xl">
          <div className="mb-2 text-[10px] tracking-wider text-ink-3 uppercase">Open on your phone</div>
          {error && <p role="alert" className="text-danger">{error}</p>}
          {!info && !error && (
            <p role="status" className="text-[11px] text-ink-3">
              Finding this computer's address…
            </p>
          )}
          {info && (
            <>
              <div role="img" aria-label={`QR code for ${info.lan_url}`} className="grid place-items-center rounded-lg bg-white p-2 [&_svg]:h-40 [&_svg]:w-40" dangerouslySetInnerHTML={{ __html: info.qr_svg }} />
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink select-text" title={info.lan_url}>{info.lan_url}</code>
                <button
                  type="button"
                  aria-label={copied ? "Copied" : "Copy link"}
                  title={copied ? "Copied" : "Copy link"}
                  disabled={copying}
                  onClick={() => {
                    setError(null);
                    setCopying(true);
                    void copyText(info.lan_url)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                      .catch((e: unknown) => setError(errorMessage(e)))
                      .finally(() => setCopying(false));
                  }}
                  className="grid size-6 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-40"
                >
                  <Icon icon={copied ? Check : Copy} size={12} />
                </button>
                <span role="status" aria-live="polite" className="sr-only">
                  {copied ? "Link copied" : ""}
                </span>
              </div>
              <p className="mt-2 text-[11px] text-ink-3">Same Wi-Fi required. Localhost is rewritten to this computer's LAN address.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
