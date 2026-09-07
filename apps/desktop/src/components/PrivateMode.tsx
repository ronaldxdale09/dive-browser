import { ArrowUpRight, Download, EyeOff, Globe2, Shield, X } from "lucide-react";
import { useRef, useState } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { ipc } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { runCommand } from "../lib/commands";
import { Icon } from "./Icon";

const SESSION_NOTE = "History, cookies, and site data stay out of your normal profile. Close every private window to end this session and clear its browsing data.";
const NETWORK_NOTE = "Private browsing does not hide your activity from websites, your employer, or your internet provider.";

/** Persistent text and shield: color is never the only indication of this mode. */
export function PrivateBadge() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const normal = async () => {
    setBusy(true); setError(null);
    try { await ipc.windowOpen(); close(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  };
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useCoversContent(open);
  useFocusTrap(panel, { active: open, onEscape: close });
  return (
    <div className="relative shrink-0">
      <button ref={trigger} type="button" aria-label="Private mode information" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className="private-badge flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium">
        <Icon icon={Shield} size={13} /> Private
      </button>
      {open && <>
        <button type="button" tabIndex={-1} aria-label="Dismiss private information" className="fixed inset-0 z-40 cursor-default" onClick={close} />
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="private-info-title" className="fixed top-12 right-3 z-50 w-[min(340px,calc(100vw-24px))] rounded-xl border border-line-2 bg-surface p-5 shadow-xl">
          <div className="mb-4 flex items-center gap-2">
            <Icon icon={Shield} size={16} className="text-highlight" />
            <h2 id="private-info-title" className="flex-1 text-sm font-semibold">Private window</h2>
            <button type="button" aria-label="Close private information" onClick={close} className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-3"><Icon icon={X} size={15} /></button>
          </div>
          <p className="text-xs leading-relaxed text-ink-2">{SESSION_NOTE}</p>
          <p className="mt-3 text-xs leading-relaxed text-ink-2">Downloads and files you explicitly export remain on your device. Save bookmarks in a normal window.</p>
          <div className="my-4 h-px bg-line" />
          <p className="text-xs leading-relaxed text-ink-2">{NETWORK_NOTE}</p>
          <div className="mt-4 grid gap-2 border-t border-line pt-4">
            <button type="button" disabled={busy} onClick={() => void normal()} className="h-9 rounded-lg border border-line-2 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50">{busy ? "Opening normal window…" : "Open a normal window"}</button>
            <button type="button" onClick={() => void ipc.windowExitPrivate().catch((error: unknown) => setError(errorMessage(error)))} className="h-9 rounded-lg bg-accent text-xs font-medium text-accent-ink hover:opacity-90">Exit private mode</button>
            <p className="text-[10px] leading-4 text-ink-3">Exit closes every private window and clears this session.</p>
            {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          </div>
        </div>
      </>}
    </div>
  );
}

export function PrivateWelcome({ onBrowse }: { onBrowse?: () => void }) {
  return (
    <section data-native-overlay aria-labelledby="private-welcome-title" className="absolute inset-0 overflow-auto bg-ground px-8 py-12">
      <div className="mx-auto flex min-h-full max-w-[640px] flex-col justify-center py-4">
        <div className="private-emblem mb-7 grid size-16 place-items-center rounded-2xl border"><Icon icon={Shield} size={29} strokeWidth={1.4} /></div>
        <p className="mb-3 font-mono text-[10px] font-medium tracking-[0.16em] text-highlight uppercase">DIVE / PRIVATE SESSION</p>
        <h1 id="private-welcome-title" className="text-[clamp(28px,3.3vw,42px)] leading-[1.12] font-semibold tracking-[-0.045em]">A little space to yourself.</h1>
        <p className="mt-5 max-w-[530px] text-[13px] leading-6 text-ink-2">{SESSION_NOTE}</p>
        <div className="mt-8 grid gap-5 border-y border-line py-6 sm:grid-cols-2">
          <div><Icon icon={EyeOff} size={18} className="mb-3 text-highlight" /><h2 className="mb-1.5 text-xs font-medium">A separate session</h2><p className="text-xs leading-5 text-ink-2">Private windows share temporary logins. Your normal windows stay separate.</p></div>
          <div><Icon icon={Download} size={18} className="mb-3 text-ink-2" /><h2 className="mb-1.5 text-xs font-medium">You decide what to keep</h2><p className="text-xs leading-5 text-ink-2">Downloads and deliberate exports remain. Save bookmarks in a normal window.</p></div>
        </div>
        <p className="mt-5 flex items-start gap-2.5 text-[11px] leading-5 text-ink-3"><Icon icon={Globe2} size={14} className="mt-1 shrink-0" />{NETWORK_NOTE}</p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button type="button" onClick={onBrowse ?? (() => runCommand("address.focus"))} className="flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-xs font-medium text-accent-ink hover:opacity-90">Browse privately <Icon icon={ArrowUpRight} size={14} /></button>
          <span className="text-[10px] text-ink-3">Agents and extensions are off in private mode.</span>
        </div>
      </div>
    </section>
  );
}
