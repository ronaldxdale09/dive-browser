import { ArrowLeft, ArrowRight, Lock, PanelsTopLeft, RotateCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { events, ipc } from "../lib/ipc";
import { createBoundsReporter, elementBounds } from "../lib/boundsReporter";
import { useBrowser } from "../store/browser";
import { usePrefs, watchReducedMotion, watchSystemTheme } from "../store/prefs";
import { Icon, IconButton } from "./Icon";
import { Favicon } from "./Favicon";
import { tabLabel } from "./TabStrip";

/** Keep commands in a detached window on the same visible error path as the main chrome. */
function run(action: Promise<unknown>) {
  void action.catch((error: unknown) => useBrowser.setState({ error: error instanceof Error ? error.message : String(error) }));
}

/**
 * A complete Dive window around one torn-off tab. The live native page is
 * reparented into this window, so navigation state, scroll and session data
 * survive the move. The tab still belongs to its workspace; the strip in the
 * main window shows it dimmed and a click there raises this window.
 */
export function Popout({ tabId }: { tabId: string }) {
  const boot = useBrowser((s) => s.boot);
  const tabs = useBrowser((s) => s.tabs);
  const loadPrefs = usePrefs((s) => s.load);
  const tab = tabs.find((t) => t.id === tabId);
  const url = tab?.url ?? "";
  const [draft, setDraft] = useState({ url, value: url });
  if (draft.url !== url) setDraft({ url, value: url });
  const inputRef = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => void boot(), [boot]);
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
            break;
          default:
            break;
        }
      })
      .then((un) => {
        if (live) stop = un;
        else un();
      })
      .catch((error: unknown) => useBrowser.setState({ error: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
      stop?.();
    };
  }, [tabId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "w") run(ipc.tabClose(tabId));
      else if (key === "l") inputRef.current?.focus();
      else if (key === "r") run(ipc.tabReload(tabId));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId]);

  const secure = url.startsWith("https://");
  const title = tab ? tabLabel(tab) : "Opening tab";
  return (
    <div className="grid h-full grid-rows-[40px_44px_minmax(0,1fr)] bg-ground text-ink">
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
        <div className="min-w-8 flex-1 self-stretch" data-tauri-drag-region="true" />
      </header>
      <nav aria-label="Browser controls" className="flex min-w-0 items-center gap-1 border-b border-line px-2">
        <IconButton icon={ArrowLeft} label="Back" onClick={() => run(ipc.tabBack(tabId))} />
        <IconButton icon={ArrowRight} label="Forward" onClick={() => run(ipc.tabForward(tabId))} />
        <IconButton icon={RotateCw} label="Reload" shortcut="⌘R" size={14} onClick={() => run(ipc.tabReload(tabId))} />
        <form
          className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(ipc.tabNavigate(tabId, draft.value));
          }}
        >
          <Icon icon={secure ? Lock : Search} size={13} className="shrink-0 text-ink-3" />
          <input ref={inputRef} aria-label="Address" value={draft.value} onChange={(e) => setDraft({ url, value: e.target.value })} onFocus={(e) => e.target.select()} spellCheck={false} className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" placeholder="Search or enter address" />
        </form>
        <IconButton icon={PanelsTopLeft} label="Move back to main window" tooltipAlign="end" onClick={() => run(ipc.tabAttach(tabId))} />
      </nav>
      <div ref={body} className="min-h-0 flex-1 bg-surface" />
    </div>
  );
}
