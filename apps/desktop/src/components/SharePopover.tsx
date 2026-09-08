import { Check, Copy, Share } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { ShareInfo } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { errorMessage } from "../lib/errors";

/** Share button: the current URL rewritten to this machine's LAN address, as a QR code. */
export function SharePopover() {
  const current = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab));
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open });

  useEffect(() => {
    if (!open || !current) return;
    let alive = true;
    ipc
      .shareUrl(current.url)
      .then((i) => alive && (setInfo(i), setError(null)))
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, current]);

  return (
    <div ref={ref} className="relative">
      <Tooltip label="Share to another device">
        <button
          type="button"
          aria-label="Share to another device"
          aria-expanded={open}
          disabled={!current}
          onClick={() => setOpen((o) => !o)}
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
              Finding this Mac's address…
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
                  disabled={copying}
                  onClick={() => {
                    setError(null);
                    setCopying(true);
                    void navigator.clipboard
                      .writeText(info.lan_url)
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
              <p className="mt-2 text-[11px] text-ink-3">Same Wi-Fi required. Localhost is rewritten to this Mac's LAN address.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
