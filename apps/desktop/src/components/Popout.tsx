import { ArrowLeft, ArrowRight, Lock, PanelsTopLeft, RotateCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { events, ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { usePrefs, watchSystemTheme } from "../store/prefs";
import { Icon, IconButton } from "./Icon";

/**
 * The chrome of a window holding one torn-off tab: a navigation row and the
 * page. The tab still belongs to its workspace; the strip in the main window
 * shows it dimmed and a click there raises this window.
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
    return watchSystemTheme();
  }, [loadPrefs]);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void ipc.popoutSetBounds(tabId, { x: r.left, y: r.top, width: r.width, height: r.height }).catch(() => undefined);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
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
            void ipc.tabClose(tabId);
            break;
          case "tab.reload":
            void ipc.tabReload(tabId);
            break;
          case "tab.back":
            void ipc.tabBack(tabId);
            break;
          case "tab.forward":
            void ipc.tabForward(tabId);
            break;
          case "tab.devtools":
            void ipc.tabDevtools(tabId);
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
      });
    return () => {
      live = false;
      stop?.();
    };
  }, [tabId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "w") void ipc.tabClose(tabId);
      else if (key === "l") inputRef.current?.focus();
      else if (key === "r") void ipc.tabReload(tabId);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId]);

  const secure = url.startsWith("https://");
  return (
    <div className="flex h-full flex-col bg-ground text-ink">
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <IconButton icon={ArrowLeft} label="Back" onClick={() => void ipc.tabBack(tabId)} />
        <IconButton icon={ArrowRight} label="Forward" onClick={() => void ipc.tabForward(tabId)} />
        <IconButton icon={RotateCw} label="Reload" shortcut="⌘R" size={14} onClick={() => void ipc.tabReload(tabId)} />
        <form
          className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ipc.tabNavigate(tabId, draft.value);
          }}
        >
          <Icon icon={secure ? Lock : Search} size={13} className="shrink-0 text-ink-3" />
          <input ref={inputRef} aria-label="Address" value={draft.value} onChange={(e) => setDraft({ url, value: e.target.value })} onFocus={(e) => e.target.select()} spellCheck={false} className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" placeholder="Search or enter address" />
        </form>
        <IconButton icon={PanelsTopLeft} label="Move back to main window" tooltipAlign="end" onClick={() => void ipc.tabAttach(tabId)} />
      </div>
      <div ref={body} className="min-h-0 flex-1 bg-surface" />
    </div>
  );
}
