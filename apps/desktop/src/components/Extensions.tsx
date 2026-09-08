import { AlertTriangle, FolderOpen, Puzzle, RotateCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { ExtensionInfo, ExtensionList } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { errorMessage } from "../lib/errors";

/** Manage unpacked Chromium extensions loaded into CEF on restart. */
export function Extensions() {
  useCoversContent(true);
  const toggle = useBrowser((state) => state.toggle);
  const root = useRef<HTMLDivElement>(null);
  const loadButton = useRef<HTMLButtonElement>(null);
  const { close, className } = useFadeClose(() => toggle("extensions", false));
  useFocusTrap(root, { initialFocus: loadButton, onEscape: close });
  const [data, setData] = useState<ExtensionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc.extensionsList().then((value) => alive && setData(value)).catch((reason: unknown) => alive && setError(errorMessage(reason)));
    return () => { alive = false; };
  }, []);

  const update = async (operation: () => Promise<ExtensionList>) => {
    setBusy(true);
    setError(null);
    try { setData(await operation()); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  const load = async () => {
    const selected = await ipc.extensionPick();
    if (typeof selected === "string") await update(() => ipc.extensionImport(selected));
  };

  return (
    <div ref={root} className={`fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-[2px] ${className}`} onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Extensions" onMouseDown={(event) => event.stopPropagation()} className="flex h-[min(680px,88vh)] w-[760px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="grid size-8 place-items-center rounded-lg bg-accent/10 text-accent"><Icon icon={Puzzle} size={17} /></span>
          <div className="min-w-0 flex-1"><h2 className="text-sm font-medium text-ink">Chromium extensions</h2><p className="text-[11px] text-ink-3">Load trusted unpacked Manifest V2 or V3 extensions</p></div>
          <button ref={loadButton} type="button" disabled={busy} onClick={() => void load()} className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"><Icon icon={FolderOpen} size={13} />Load unpacked</button>
          <IconButton icon={X} label="Close extensions" onClick={close} />
        </header>
        {data?.restart_required && <div role="status" className="flex items-center gap-2 border-b border-highlight/25 bg-highlight/10 px-4 py-2 text-xs text-ink"><Icon icon={RotateCw} size={13} className="text-highlight" /><span className="flex-1">Restart Dive to apply extension changes.</span><button type="button" onClick={() => ipc.appRestart()} className="rounded-md border border-line-2 px-2.5 py-1 text-[11px] hover:bg-surface-3">Restart now</button></div>}
        {error && <div role="alert" className="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger"><Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" /><span>{error}</span></div>}
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          {data === null && !error ? <p className="p-6 text-center text-xs text-ink-3">Loading extensions…</p> : data?.items.length === 0 ? <EmptyState /> : <div className="flex flex-col gap-3">{data?.items.map((item) => <ExtensionCard key={item.id} item={item} busy={busy} onToggle={(enabled) => void update(() => ipc.extensionSetEnabled(item.id, enabled))} onRemove={() => void update(() => ipc.extensionRemove(item.id))} />)}</div>}
        </main>
        <footer className="flex items-center gap-2 border-t border-line px-4 py-3 text-[11px] text-ink-3"><Icon icon={ShieldCheck} size={13} />Extensions can read pages covered by their declared permissions. Only load code you trust.</footer>
      </div>
    </div>
  );
}

function ExtensionCard({ item, busy, onToggle, onRemove }: { item: ExtensionInfo; busy: boolean; onToggle: (enabled: boolean) => void; onRemove: () => void }) {
  return <article className="rounded-xl border border-line bg-surface-2 p-3.5">
    <div className="flex items-start gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface text-ink-2"><Icon icon={Puzzle} size={19} /></span>
      <div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><h3 className="truncate text-sm font-medium text-ink">{item.name}</h3><span className="font-mono text-[10px] text-ink-3">v{item.version} · MV{item.manifest_version}</span></div><p className="mt-0.5 truncate font-mono text-[10px] text-ink-3" title={item.path}>{item.path}</p></div>
      <label className="flex items-center gap-2 text-[11px] text-ink-2"><input type="checkbox" aria-label={`Enable ${item.name}`} checked={item.enabled} disabled={busy} onChange={(event) => onToggle(event.target.checked)} className="accent-accent" />Enabled</label>
      <button type="button" aria-label={`Remove ${item.name}`} disabled={busy} onClick={onRemove} className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-danger/10 hover:text-danger disabled:opacity-40"><Icon icon={Trash2} size={14} /></button>
    </div>
    {item.permissions.length > 0 && <details className="mt-3 border-t border-line pt-2"><summary className="cursor-pointer text-[11px] text-ink-2">Requested permissions ({item.permissions.length})</summary><div className="mt-2 flex flex-wrap gap-1">{item.permissions.map((permission) => <code key={permission} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-2">{permission}</code>)}</div></details>}
    {item.warnings.map((warning) => <p key={warning} className="mt-2 flex items-start gap-1.5 text-[11px] text-highlight"><Icon icon={AlertTriangle} size={12} className="mt-0.5 shrink-0" />{warning}</p>)}
  </article>;
}

function EmptyState() {
  return <div className="grid min-h-72 place-items-center text-center"><div className="max-w-sm"><span className="mx-auto grid size-14 place-items-center rounded-2xl border border-line bg-surface-2 text-ink-3"><Icon icon={Puzzle} size={24} /></span><h3 className="mt-4 text-sm font-medium text-ink">No extensions loaded</h3><p className="mt-1.5 text-xs leading-5 text-ink-3">Choose a folder holding an unpacked extension, the one with its <code>manifest.json</code>.</p><p className="mt-2 text-xs leading-5 text-ink-3">Where to find one: the extension&rsquo;s source from GitHub, unzipped; or one Chrome, Brave or Edge already has, kept unpacked under Library &rsaquo; Application Support &rsaquo; that browser &rsaquo; Default &rsaquo; Extensions &rsaquo; its id &rsaquo; version.</p><p className="mt-2 text-xs leading-5 text-ink-3">Web Store installs and Google-only services are not available in embedded Chromium.</p></div></div>;
}

