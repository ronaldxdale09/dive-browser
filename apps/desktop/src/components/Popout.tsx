import { prettyUrl } from "../lib/prettyUrl";
import { ArrowLeft, ArrowRight, Lock, PanelsTopLeft, Plus, RotateCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { events, ipc } from "../lib/ipc";
import { createBoundsReporter, elementBounds } from "../lib/boundsReporter";
import { useBrowser } from "../store/browser";
import { usePrefs, watchReducedMotion, watchSystemTheme } from "../store/prefs";
import { Icon, IconButton } from "./Icon";
import { Favicon } from "./Favicon";
import { tabLabel } from "./TabStrip";
import { usePopoutPage } from "../lib/usePopoutPage";
import { useTabHistory } from "../lib/useTabHistory";
import { isMac, shortcutFor } from "../lib/commands";
import { selectAllInChromeField } from "../lib/chromeEditing";
import { errorMessage } from "../lib/errors";

/** Keep commands in a detached window on the same visible error path as the main chrome. */
function run(action: Promise<unknown>) {
  void action.catch((error: unknown) => useBrowser.setState({ error: errorMessage(error) }));
}

/**
 * A complete Dive window around one torn-off tab. The live native page is
 * reparented into this window, so navigation state, scroll and session data
 * survive the move. The tab still belongs to its workspace; the strip in the
 * main window shows it dimmed and a click there raises this window.
 */
export function Popout({ tabId }: { tabId: string }) {
  const { tab, loading, ready } = usePopoutPage(tabId);
  const error = useBrowser((state) => state.error);
  const loadPrefs = usePrefs((s) => s.load);
  const url = tab?.url ?? "";
  const { canBack, canForward } = useTabHistory(tab?.id ?? null, url, loading);
  const [draft, setDraft] = useState({ tabId, value: url });
  const [editing, setEditing] = useState(false);
  if (draft.tabId !== tabId) setDraft({ tabId, value: url });
  // At rest the popout shows the same trimmed address as the main window.
  const value = editing ? draft.value : prettyUrl(url);
  const inputRef = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [menuReady, setMenuReady] = useState(false);
  const interacted = useRef(false);
  const readyRequested = useRef<string | null>(null);
  const navigationGeneration = useRef(0);
  useEffect(() => () => { navigationGeneration.current++; }, [tabId]);
  useEffect(() => {
    const touched = () => { interacted.current = true; };
    window.addEventListener("pointerdown", touched, true);
    window.addEventListener("keydown", touched, true);
    window.addEventListener("input", touched, true);
    return () => {
      window.removeEventListener("pointerdown", touched, true);
      window.removeEventListener("keydown", touched, true);
      window.removeEventListener("input", touched, true);
    };
  }, []);
  useEffect(() => {
    if (!ready || !menuReady || interacted.current || readyRequested.current === tabId) return;
    let live = true;
    readyRequested.current = tabId;
    void ipc.popoutReady(tabId).then((focusAddress) => {
      if (live && focusAddress && !interacted.current) {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }).catch((error: unknown) => {
      if (live) useBrowser.setState({ error: errorMessage(error) });
    });
    return () => { live = false; };
  }, [ready, menuReady, tabId]);

  useEffect(() => {
    void loadPrefs();
    const stopTheme = watchSystemTheme();
    const stopMotion = watchReducedMotion();
    return () => {
      stopTheme();
      stopMotion();
    };
  }, [loadPrefs]);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const reporter = createBoundsReporter(
      () => elementBounds(el),
      (bounds) => run(ipc.popoutSetBounds(tabId, bounds)),
    );
    reporter.schedule();
    const ro = new ResizeObserver(reporter.schedule);
    ro.observe(el);
    window.addEventListener("resize", reporter.schedule);
    return () => {
      reporter.dispose();
      ro.disconnect();
      window.removeEventListener("resize", reporter.schedule);
    };
  }, [tabId]);

  // Menu shortcuts (⌘W, ⌘R, ⌘L...) arrive as menu commands while this window
  // is focused, whether the page or the chrome had the keyboard.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void events.menuCommand
      .listen((e) => {
        switch (e.payload) {
          case "tab.close":
            run(ipc.tabClose(tabId));
            break;
          case "tab.reload":
            run(ipc.tabReload(tabId));
            break;
          case "tab.back":
            run(ipc.tabBack(tabId));
            break;
          case "tab.forward":
            run(ipc.tabForward(tabId));
            break;
          case "tab.devtools":
            run(ipc.tabDevtools(tabId));
            break;
          case "address.focus":
            inputRef.current?.focus();
            inputRef.current?.select();
            break;
          case "tab.new":
          case "window.new":
            run(ipc.windowCommand(e.payload));
            break;
          default:
            break;
        }
      })
      .then((un) => {
        if (live) { stop = un; setMenuReady(true); }
        else un();
      })
      .catch((error: unknown) => useBrowser.setState({ error: errorMessage(error) }));
    return () => {
      live = false;
      stop?.();
    };
  }, [tabId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || selectAllInChromeField(e, isMac())) return;
      const command = shortcutFor(e);
      switch (command) {
        case "tab.close": run(ipc.tabClose(tabId)); break;
        case "address.focus": inputRef.current?.focus(); inputRef.current?.select(); break;
        case "tab.reload": run(ipc.tabReload(tabId)); break;
        case "tab.new":
        case "window.new": run(ipc.windowCommand(command)); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId]);

  useEffect(() => {
    const focusAddress = () => {
      flushSync(() => inputRef.current?.focus());
      inputRef.current?.select();
    };
    window.addEventListener("dive-native-focus-address", focusAddress);
    return () => window.removeEventListener("dive-native-focus-address", focusAddress);
  }, []);

  const secure = url.startsWith("https://");
  const title = tab ? tabLabel(tab) : "Opening tab";
  return (
    <div className="grid h-full grid-rows-[40px_44px_auto_minmax(0,1fr)] bg-ground text-ink">
      <header className="flex min-w-0 items-center gap-1.5 border-b border-line/70 pr-2 pl-[84px]">
        <div role="tablist" aria-label="Window tabs" className="flex min-w-0 max-w-72 flex-1 items-center">
          <div className="group flex h-8 min-w-0 flex-1 items-center rounded-lg bg-surface-2 text-xs text-ink ring-1 ring-line-2">
            <button
              type="button"
              role="tab"
              aria-label={title}
              aria-selected="true"
              data-tab-drag-handle
              data-tauri-drag-region="false"
              onMouseDown={(e) => e.stopPropagation()}
              className="flex h-full min-w-0 flex-1 items-center gap-2 bg-transparent px-2.5 outline-none"
            >
              <Favicon src={tab?.favicon ?? null} size={14} />
              <span className="truncate">{title}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${title}`}
              data-tauri-drag-region="false"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => run(ipc.tabClose(tabId))}
              className="mr-1 grid size-5 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <Icon icon={X} size={12} />
            </button>
          </div>
        </div>
        <IconButton icon={Plus} label="New tab in main window" shortcut="⌘T" onClick={() => run(ipc.windowCommand("tab.new"))} />
        <div className="min-w-8 flex-1 self-stretch" data-tauri-drag-region="true" />
      </header>
      <nav aria-label="Browser controls" className="flex min-w-0 items-center gap-1 border-b border-line px-2">
        <IconButton icon={ArrowLeft} label="Back" disabled={!canBack} onClick={() => run(ipc.tabBack(tabId))} />
        <IconButton icon={ArrowRight} label="Forward" disabled={!canForward} onClick={() => run(ipc.tabForward(tabId))} />
        {loading
          ? <IconButton icon={X} label="Stop loading" onClick={() => run(ipc.tabStop(tabId))} />
          : <IconButton icon={RotateCw} label="Reload" shortcut="⌘R" size={14} disabled={!tab} onClick={() => run(ipc.tabReload(tabId))} />}

        <form
          className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            const generation = ++navigationGeneration.current;
            run(ipc.tabNavigate(tabId, value).then(() => {
              if (generation === navigationGeneration.current && inputRef.current) return ipc.tabActivate(tabId);
            }));
            setEditing(false);
            inputRef.current?.blur();
          }}
        >
          <Icon icon={secure ? Lock : Search} size={13} className="shrink-0 text-ink-3" />
          <input ref={inputRef} aria-label="Address" value={value}
            onChange={(e) => setDraft({ tabId, value: e.target.value })}
            onFocus={(e) => { setEditing(true); setDraft({ tabId, value: url }); e.currentTarget.select(); }}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(false); e.currentTarget.blur(); }
            }}
            spellCheck={false} className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" placeholder="Search or enter address" />
        </form>
        <IconButton icon={PanelsTopLeft} label="Move back to main window" tooltipAlign="end" onClick={() => run(ipc.tabAttach(tabId))} />
      </nav>
      <div>
        {error && <div role="alert" className="flex items-start gap-2 border-b border-line bg-surface px-3 py-2 text-xs text-danger">
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <button type="button" aria-label="Dismiss error" onClick={() => useBrowser.setState({ error: null })} className="grid size-5 shrink-0 place-items-center rounded hover:bg-surface-2"><Icon icon={X} size={13} /></button>
        </div>}
      </div>
      <div ref={body} className="min-h-0 flex-1 bg-surface" />
    </div>
  );
}
