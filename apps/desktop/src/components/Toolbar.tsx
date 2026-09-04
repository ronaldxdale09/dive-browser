import { ArrowLeft, ArrowRight, Bug, Camera, LoaderCircle, Lock, MoreHorizontal, PanelBottom, Puzzle, RotateCw, Search, X, Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FOCUS_ADDRESS } from "../lib/commands";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { SharePopover } from "./SharePopover";
import { BookmarkButton } from "./BookmarkButton";
import { DownloadsMenu } from "./DownloadsMenu";
import { ProtectionMenu } from "./ProtectionMenu";
import { MainMenu } from "./MainMenu";
import { Tooltip } from "./Tooltip";
import { usePicker } from "../store/simulator";

/** Navigation row: nav icons, the omnibox pill and, as glyphs, the actions that act on the page. */
export function Toolbar({ compact = false }: { compact?: boolean }) {
  const tabs = useBrowser((s) => s.tabs);
  const activeTab = useBrowser((s) => s.activeTab);
  const navigate = useBrowser((s) => s.navigate);
  const back = useBrowser((s) => s.back);
  const forward = useBrowser((s) => s.forward);
  const reload = useBrowser((s) => s.reload);
  const stop = useBrowser((s) => s.stop);
  const capture = useBrowser((s) => s.capture);
  const capturing = useBrowser((s) => s.capturing);
  const devtools = useBrowser((s) => s.devtools);
  const toggle = useBrowser((s) => s.toggle);
  const open = useBrowser((s) => s.open);
  const pickerOpen = usePicker((s) => s.open);
  const setPickerOpen = usePicker((s) => s.setOpen);
  const loading = useBrowser((s) => (s.activeTab ? s.loading[s.activeTab] === true : false));
  const current = tabs.find((t) => t.id === activeTab);
  const url = current?.url ?? "";
  // Reset the draft whenever the active tab's URL changes (adjust-state-during-render).
  const [draft, setDraft] = useState({ url, value: url });
  if (draft.url !== url) setDraft({ url, value: url });
  const value = draft.value;
  const setValue = (v: string) => setDraft({ url, value: v });
  const secure = url.startsWith("https://");
  const display = pretty(url);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleDock = () => {
    if (!compact) {
      toggle("dock");
      return;
    }
    if (open.dock && !open.sidecar && !pickerOpen) {
      toggle("dock", false);
      return;
    }
    setPickerOpen(false);
    toggle("sidecar", false);
    toggle("dock", true);
  };
  // Cmd+L, from the menu or the palette.
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener(FOCUS_ADDRESS, focus);
    return () => window.removeEventListener(FOCUS_ADDRESS, focus);
  }, []);

  return (
    <div className="relative flex h-full items-center gap-1 px-2">
      <IconButton icon={ArrowLeft} label="Back" disabled={!current} onClick={() => void back()} />
      <IconButton icon={ArrowRight} label="Forward" disabled={!current} onClick={() => void forward()} />
      {/* While the page loads the same slot stops it, as in every browser. */}
      {loading ? (
        <IconButton icon={X} label="Stop loading" shortcut="Esc" disabled={!current} onClick={() => void stop()} size={14} />
      ) : (
        <IconButton icon={RotateCw} label="Reload" shortcut="⌘R" disabled={!current} onClick={() => void reload()} size={14} />
      )}
      <form
        className="mx-1 flex h-[calc(var(--row-h)-4px)] min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate(value);
        }}
      >
        <Icon icon={current ? (secure ? Lock : Search) : Search} size={13} className="shrink-0 text-ink-3" />
        <input
          ref={inputRef}
          aria-label="Address"
          value={value === url ? display : value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => {
            setValue(url);
            requestAnimationFrame(() => e.target.select());
          }}
          onBlur={() => setValue(url)}
          placeholder="Search or enter address"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
        />
      </form>
      {compact ? (
        <ToolbarMore>
          <ZoomBadge />
          <BookmarkButton />
          <SharePopover />
          <IconButton icon={Puzzle} label="Extensions" active={open.extensions ?? false} onClick={() => toggle("extensions")} />
          <span className={capturing ? "animate-spin motion-reduce:animate-none" : undefined}><IconButton icon={capturing ? LoaderCircle : Camera} label={capturing ? "Capturing full page" : "Capture full page"} shortcut="⌘⇧S" disabled={!current || capturing} onClick={() => void capture(true)} /></span>
          <IconButton icon={Bug} label="Open DevTools" shortcut="⌘⌥I" disabled={!current} onClick={() => void devtools()} />
          <IconButton icon={PanelBottom} label="Developer dock" shortcut="⌘⇧D" active={open.dock && !open.sidecar} onClick={toggleDock} />
          <DownloadsMenu compact />
        </ToolbarMore>
      ) : (
        <>
          <ZoomBadge />
          <BookmarkButton />
          <SharePopover />
          <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
          <IconButton icon={Puzzle} label="Extensions" active={open.extensions ?? false} onClick={() => toggle("extensions")} />
          <span className={capturing ? "animate-spin motion-reduce:animate-none" : undefined}><IconButton icon={capturing ? LoaderCircle : Camera} label={capturing ? "Capturing full page" : "Capture full page"} shortcut="⌘⇧S" disabled={!current || capturing} onClick={() => void capture(true)} /></span>
          <IconButton icon={Bug} label="Open DevTools" shortcut="⌘⌥I" disabled={!current} onClick={() => void devtools()} />
          <IconButton icon={PanelBottom} label="Developer dock" shortcut="⌘⇧D" active={open.dock} onClick={toggleDock} />
          <DownloadsMenu compact />
        </>
      )}
      <ProtectionMenu compact />
      <IconButton icon={Menu} label="Menu" active={open.menu} onClick={() => toggle("menu")} tooltipAlign="end" />
      {open.menu && <MainMenu />}
      {loading && <LoadingLine />}
    </div>
  );
}

/** Secondary page actions collapse into a small tray before the omnibox does. */
function ToolbarMore({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={root} className="relative shrink-0">
      <IconButton icon={MoreHorizontal} label="More page actions" active={open} onClick={() => setOpen((value) => !value)} tooltipAlign="end" />
      {open && (
        <div role="dialog" aria-label="Page actions" className="surface-enter absolute top-full right-0 z-50 mt-1 flex items-center gap-0.5 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Indeterminate progress along the toolbar's bottom edge while the active
 * tab's main frame loads. Chromium gives no byte counts for the document, so
 * the bar sweeps rather than fills; with reduced motion it simply shows.
 */
function LoadingLine() {
  return (
    <div role="progressbar" aria-label="Loading page" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-accent/15">
      <style>{`@keyframes dive-loading-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
      <div className="h-full w-1/3 rounded-full bg-accent animate-[dive-loading-sweep_1.1s_cubic-bezier(0.4,0,0.6,1)_infinite] motion-reduce:w-full motion-reduce:animate-none" data-testid="loading-sweep" />
    </div>
  );
}

/** Hostname plus path, scheme dropped, for the resting omnibox. */
function pretty(url: string) {
  // Dive's own pages keep their scheme: "dive://screen" says what it is.
  if (url.startsWith("dive://")) return url.split("?")[0] ?? url;
  try {
    const u = new URL(url);
    const path = u.pathname === "/" && !u.search ? "" : u.pathname + u.search;
    return u.host + path;
  } catch {
    return url;
  }
}

/** Shows the active tab's zoom when it is not 100%; click resets. */
function ZoomBadge() {
  const active = useBrowser((s) => s.activeTab);
  const zoom = useBrowser((s) => (active ? s.zoom[active] : undefined) ?? 1);
  const zoomStep = useBrowser((s) => s.zoomStep);
  if (Math.abs(zoom - 1) < 0.001) return null;
  return (
    <Tooltip label="Reset zoom" shortcut="⌘0">
      <button
        type="button"
        aria-label="Reset zoom"
        onClick={() => void zoomStep(0)}
        className="mr-1 h-6 rounded-full border border-line px-2 font-mono text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        {Math.round(zoom * 100)}%
      </button>
    </Tooltip>
  );
}
