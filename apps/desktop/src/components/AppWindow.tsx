import { ArrowLeft, ArrowRight, Copy, EllipsisVertical, PanelsTopLeft, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { events, ipc } from "../lib/ipc";
import type { WebApp } from "../lib/ipc";
import { createBoundsReporter, elementBounds } from "../lib/boundsReporter";
import { useBrowser } from "../store/browser";
import { usePrefs, watchReducedMotion, watchSystemTheme } from "../store/prefs";
import { Icon, IconButton } from "./Icon";
import { usePopoutPage } from "../lib/usePopoutPage";
import { useTabHistory } from "../lib/useTabHistory";
import { useDismiss } from "../lib/useDismiss";
import { errorMessage } from "../lib/errors";
import { NavErrorPanel } from "./Content";
import { inScope, originOf, useWebApps } from "../store/webapps";
import { useWebAppIcon } from "../lib/useWebAppIcon";
import { isWindows } from "../lib/commands";
import { WindowResizeEdges } from "./WindowResizeEdges";
import { WindowControls } from "./WindowControls";

function run(action: Promise<unknown>) {
  void action.catch((error: unknown) => useBrowser.setState({ error: errorMessage(error) }));
}

/**
 * The chrome of an installed app's window: one row with the app's icon and
 * name, back/forward, and a menu — no tabs, no address bar. When the page
 * wanders outside the app's scope a thin bar names where it went and offers
 * the site in a normal tab, which is what Chrome's "custom tab" strip does.
 */
export function AppWindow({ tabId, appId }: { tabId: string; appId: string }) {
  const { tab, loading, ready } = usePopoutPage(tabId);
  const [app, setApp] = useState<WebApp | null>(null);
  const error = useBrowser((state) => state.error);
  const navError = useBrowser((state) => state.navError[tabId]);
  const loadPrefs = usePrefs((s) => s.load);
  const url = tab?.url ?? "";
  const { canBack, canForward } = useTabHistory(tab?.id ?? null, url, loading);
  const body = useRef<HTMLDivElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  useDismiss(menuRoot, menu, closeMenu);
  const uninstall = useWebApps((s) => s.uninstall);

  useEffect(() => {
    let live = true;
    void ipc.webappForWindow(appId).then((found) => { if (live) setApp(found); }).catch((e: unknown) => {
      if (live) useBrowser.setState({ error: errorMessage(e) });
    });
    return () => { live = false; };
  }, [appId]);

  useEffect(() => {
    void loadPrefs();
    const stopTheme = watchSystemTheme();
    const stopMotion = watchReducedMotion();
    return () => { stopTheme(); stopMotion(); };
  }, [loadPrefs]);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const reporter = createBoundsReporter(() => elementBounds(el), (bounds) => run(ipc.popoutSetBounds(tabId, bounds)));
    reporter.schedule();
    const ro = new ResizeObserver(reporter.schedule);
    ro.observe(el);
    window.addEventListener("resize", reporter.schedule);
    return () => { reporter.dispose(); ro.disconnect(); window.removeEventListener("resize", reporter.schedule); };
  }, [tabId]);

  // The popout tells the host when its chrome has painted; the same handshake
  // reveals the app window.
  const readyRequested = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || readyRequested.current === tabId) return;
    readyRequested.current = tabId;
    void ipc.popoutReady(tabId).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  }, [ready, tabId]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void events.menuCommand.listen((e) => {
      switch (e.payload) {
        case "tab.close": run(ipc.tabClose(tabId)); break;
        case "tab.reload": run(ipc.tabReload(tabId)); break;
        default: break;
      }
    }).then((s) => { if (live) stop = s; else s(); });
    return () => { live = false; stop?.(); };
  }, [tabId]);

  const outside = app ? url !== "" && url !== "about:blank" && !inScope(url, app.scope) : false;
  const title = app?.name ?? tab?.title ?? "App";
  const appIcon = useWebAppIcon(app?.id);
  const icon = appIcon ?? tab?.favicon ?? null;
  const rows = `40px${outside ? " 32px" : ""} auto minmax(0,1fr)`;

  const captionGutter = isWindows() ? "pl-2" : "pl-[84px] pr-2";
  return (
    <div className="grid h-full bg-ground text-ink" style={{ gridTemplateRows: rows }}>
      <WindowResizeEdges top={outside ? 72 : 40} />
      <header className={`flex min-w-0 items-center gap-1.5 border-b border-line/70 ${captionGutter}`} data-tauri-drag-region="true">
        <IconButton icon={ArrowLeft} label="Back" disabled={!canBack} onClick={() => run(ipc.tabBack(tabId))} />
        <IconButton icon={ArrowRight} label="Forward" disabled={!canForward} onClick={() => run(ipc.tabForward(tabId))} />
        {loading
          ? <IconButton icon={X} label="Stop loading" onClick={() => run(ipc.tabStop(tabId))} />
          : <IconButton icon={RotateCw} label="Reload" shortcut="⌘R" size={14} disabled={!tab} onClick={() => run(ipc.tabReload(tabId))} />}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 self-stretch" data-tauri-drag-region="true">
          {icon && <img src={icon} alt="" width={16} height={16} className="size-4 rounded-sm" data-tauri-drag-region="true" />}
          <span className="truncate text-xs text-ink" data-tauri-drag-region="true">{title}</span>
        </div>
        <div ref={menuRoot} className="relative">
          <IconButton icon={EllipsisVertical} label="App menu" active={menu} onClick={() => setMenu((v) => !v)} tooltipAlign="end" />
          {menu && (
            <div role="menu" aria-label="App menu" className="surface-enter absolute top-full right-0 z-50 mt-1 w-56 rounded-xl border border-line-2 bg-surface p-1 text-xs shadow-2xl">
              <MenuItem icon={Copy} label="Copy URL" onClick={() => { void navigator.clipboard.writeText(url); closeMenu(); }} />
              <MenuItem icon={PanelsTopLeft} label="Open in Dive" onClick={() => { run(ipc.tabAttach(tabId)); closeMenu(); }} />
              <div className="my-1 h-px bg-line" />
              <MenuItem icon={Trash2} label={`Uninstall ${app?.short_name || title}`} danger onClick={() => { closeMenu(); void uninstall(appId); }} />
            </div>
          )}
        </div>
        <WindowControls />
      </header>
      {outside && app && (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 text-[11px] text-ink-2">
          <span className="truncate">Now on <span className="text-ink">{originOf(url)}</span>, outside {app.short_name || app.name}.</span>
          <button type="button" onClick={() => run(ipc.tabAttach(tabId))} className="ml-auto shrink-0 rounded-full border border-line-2 px-2.5 py-0.5 text-[11px] text-ink hover:bg-surface-3">
            Open in Dive
          </button>
        </div>
      )}
      <div>
        {error && (
          <div role="alert" className="flex items-start gap-2 border-b border-line bg-surface px-3 py-2 text-xs text-danger">
            <p className="min-w-0 flex-1 break-words">{error}</p>
            <button type="button" aria-label="Dismiss error" onClick={() => useBrowser.setState({ error: null })} className="grid size-5 shrink-0 place-items-center rounded hover:bg-surface-2"><Icon icon={X} size={13} /></button>
          </div>
        )}
      </div>
      <div ref={body} className="relative min-h-0 flex-1 bg-surface">
        {navError && <NavErrorPanel url={navError.url} error={navError.error} onRetry={() => run(ipc.tabReload(tabId))} />}
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger = false }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${danger ? "text-danger" : "text-ink"}`}>
      <Icon icon={icon} size={13} className={danger ? "text-danger" : "text-ink-3"} />
      <span className="truncate">{label}</span>
    </button>
  );
}
