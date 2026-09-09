import { isPrivateWindow } from "../lib/privateMode";
import { prettyUrl } from "../lib/prettyUrl";
import { Captions, CodeXml, House, ScrollText, Lock, MoreHorizontal, PanelBottom, Puzzle, RotateCw, Search, TriangleAlert, X, Menu } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FOCUS_ADDRESS } from "../lib/commands";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { SharePopover } from "./SharePopover";
import { BookmarkButton } from "./BookmarkButton";
import { AddressSuggestions, optionId, useAddressSuggestions } from "./AddressSuggestions";
import type { Suggestion } from "../lib/omnibox";
import { DownloadsMenu } from "./DownloadsMenu";
import { ProtectionMenu } from "./ProtectionMenu";
import { MainMenu } from "./MainMenu";
import { Tooltip } from "./Tooltip";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { usePicker } from "../store/simulator";
import { useSubtitles } from "../store/subtitles";
import { useRecorder } from "../store/recorder";
import { runCommand } from "../lib/commands";
import { usePrefs } from "../store/prefs";
import { NavigationButtons } from "./NavigationButtons";

/** Navigation row: nav icons, the omnibox pill and, as glyphs, the actions that act on the page. */
/**
 * `singleAuxPanel` is the window's rule that only one of the dock, the agent
 * and the picker shows at a time; the dock button then swaps them rather
 * than toggling a dock nobody can see.
 */
export function Toolbar({ compact = false, singleAuxPanel = compact, trailing = true }: { compact?: boolean; singleAuxPanel?: boolean; /** Render the browser's own controls (downloads, privacy, menu) at the end; off when the bar places them after the feature cluster. */ trailing?: boolean }) {
  const tabs = useBrowser((s) => s.tabs);
  const activeTab = useBrowser((s) => s.activeTab);
  const navigate = useBrowser((s) => s.navigate);
  const activateTab = useBrowser((s) => s.activateTab);
  const reload = useBrowser((s) => s.reload);
  const stop = useBrowser((s) => s.stop);
  const homepage = usePrefs((s) => s.prefs.homepage.trim());
  const devtools = useBrowser((s) => s.devtools);
  const toggle = useBrowser((s) => s.toggle);
  const open = useBrowser((s) => s.open);
  const pickerOpen = usePicker((s) => s.open);
  const setPickerOpen = usePicker((s) => s.setOpen);
  const loading = useBrowser((s) => (s.activeTab ? s.loading[s.activeTab] === true : false));
  const current = tabs.find((t) => t.id === activeTab);
  const failedUrl = useBrowser((s) => (s.activeTab ? s.navError[s.activeTab]?.url : undefined));
  // A load that failed leaves the bar on the address that failed, as every
  // browser does, so it can be corrected in place; the store still holds the
  // last committed URL for everything else.
  const url = failedUrl || current?.url || "";
  // A redirect must not overwrite text the person is editing. A tab switch
  // does reset the draft, even when both tabs happen to have the same URL.
  const [draft, setDraft] = useState({ tabId: activeTab, value: url });
  const [editing, setEditing] = useState(false);
  if (draft.tabId !== activeTab) setDraft({ tabId: activeTab, value: url });
  const value = editing ? draft.value : url;
  const setValue = (value: string) => setDraft({ tabId: activeTab, value });
  // A load that failed is not secure whatever its scheme says; the bar
  // shows a warning instead of a lock so a certificate error is not
  // dressed up as a safe page.
  const failed = Boolean(failedUrl);
  const secure = url.startsWith("https://") && !failed;
  const display = prettyUrl(url);
  const inputRef = useRef<HTMLInputElement>(null);
  // Suggestions live only while the draft says something other than the
  // address already shown -- focusing the bar selects the URL, and that alone
  // is not a question. The list is a listbox the input drives, so the input
  // never loses focus to it.
  const listId = useId();
  const { rows, highlight, setHighlight, move } = useAddressSuggestions(draft.value, editing && draft.value.trim() !== url, tabs);
  const finishEditing = () => {
    setEditing(false);
    inputRef.current?.blur();
  };
  const pick = (row: Suggestion) => {
    finishEditing();
    if (row.kind === "tab") void activateTab(row.tabId);
    else void navigate(row.url);
  };
  const dockShown = open.dock && !(singleAuxPanel && (open.sidecar || pickerOpen));
  const toggleDock = () => {
    if (!singleAuxPanel) {
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
    const focus = () => {
      flushSync(() => inputRef.current?.focus());
      inputRef.current?.select();
    };
    window.addEventListener(FOCUS_ADDRESS, focus);
    return () => window.removeEventListener(FOCUS_ADDRESS, focus);
  }, []);

  // Select after the full URL is committed, before the next input event.
  // A delayed animation-frame selection could overwrite newly typed text.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (editing && input && document.activeElement === input) input.select();
  }, [editing]);

  return (
    <div className="relative flex h-full items-center gap-1 px-2">
      <NavigationButtons tabId={current?.id ?? null} url={url} loading={loading} />
      {/* While the page loads the same slot stops it, as in every browser. */}
      {loading ? (
        <IconButton icon={X} label="Stop loading" shortcut="Esc" disabled={!current} onClick={() => void stop()} size={14} />
      ) : (
        <IconButton icon={RotateCw} label="Reload" shortcut="⌘R" disabled={!current} onClick={() => void reload()} size={14} />
      )}
      <IconButton icon={House} label="Home" shortcut="⌘⇧H" disabled={!current && !homepage} onClick={() => void runCommand("tab.home")} size={14} />
      <form
        className="relative mx-1 flex h-[calc(var(--row-h)-4px)] min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          const row = rows[highlight];
          if (row) {
            pick(row);
            return;
          }
          void navigate(value);
          finishEditing();
        }}
      >
        <span data-security={!current ? "none" : failed ? "failed" : secure ? "secure" : "none"} className="grid shrink-0 place-items-center">
          <Icon icon={current ? (failed ? TriangleAlert : secure ? Lock : Search) : Search} size={13} className={failed ? "text-warn" : "text-ink-3"} />
        </span>
        <input
          ref={inputRef}
          aria-label="Address"
          value={editing ? value : display}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => {
            setEditing(true);
            setValue(url);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setValue(url);
              event.currentTarget.blur();
              return;
            }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length > 0) {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
          placeholder="Search or enter address"
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={rows.length > 0}
          aria-autocomplete="list"
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-activedescendant={rows.length > 0 ? optionId(listId, highlight) : undefined}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
        />
        <AddressSuggestions id={listId} rows={rows} highlight={highlight} onHighlight={setHighlight} onPick={pick} />
      </form>
      {compact ? (
        <ToolbarMore>
          <ZoomBadge />
          {!isPrivateWindow() && <BookmarkButton />}
          <SharePopover />
          <SubtitlesIndicator />
          <RecorderIndicator />
          <IconButton icon={PanelBottom} label="Developer dock" shortcut="⌘⇧D" active={dockShown} onClick={toggleDock} />
          <IconButton icon={CodeXml} label="DevTools" shortcut="⌘⌥I" disabled={!current} onClick={() => void devtools()} />
          {!isPrivateWindow() && <IconButton icon={Puzzle} label="Extensions" active={open.extensions ?? false} onClick={() => toggle("extensions")} />}
          <DownloadsMenu compact />
        </ToolbarMore>
      ) : (
        <>
          {/* Three groups, left to right: the page (bookmark, share), the
              developer surfaces (dock, DevTools, extensions), then what is
              about the browser itself (downloads, privacy, menu). */}
          <ZoomBadge />
          {!isPrivateWindow() && <BookmarkButton />}
          <SharePopover />
          <SubtitlesIndicator />
          <RecorderIndicator />
          <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
          <IconButton icon={PanelBottom} label="Developer dock" shortcut="⌘⇧D" active={dockShown} onClick={toggleDock} />
          <IconButton icon={CodeXml} label="DevTools" shortcut="⌘⌥I" disabled={!current} onClick={() => void devtools()} />
          {!isPrivateWindow() && <IconButton icon={Puzzle} label="Extensions" active={open.extensions ?? false} onClick={() => toggle("extensions")} />}
          <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
          <DownloadsMenu compact />
        </>
      )}
      {trailing && <BrowserActions />}
      {loading && <LoadingLine />}
    </div>
  );
}

/**
 * The controls that are about the browser rather than the page: privacy
 * and the menu. They close the bar, whichever bar that is, so the menu is
 * always in the corner where every browser keeps it.
 */
export function BrowserActions() {
  const open = useBrowser((s) => s.open);
  const toggle = useBrowser((s) => s.toggle);
  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <ProtectionMenu compact />
      <IconButton icon={Menu} label="Menu" active={open.menu} onClick={() => toggle("menu")} tooltipAlign="end" />
      {open.menu && <MainMenu />}
    </div>
  );
}

/** Secondary page actions collapse into a small tray before the omnibox does. */
function ToolbarMore({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open, onEscape: () => setOpen(false) });
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("mousedown", close);
    };
  }, [open]);
  return (
    <div ref={root} className="relative shrink-0">
      <IconButton icon={MoreHorizontal} label="More page actions" active={open} onClick={() => setOpen((value) => !value)} tooltipAlign="end" />
      {open && (
        <div ref={panel} role="dialog" aria-label="Page actions" aria-modal="true" className="surface-enter absolute top-full right-0 z-50 mt-1 flex items-center gap-0.5 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl">
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

/** Shows the active tab's zoom when it is not 100%; click resets. */
function ZoomBadge() {
  const active = useBrowser((s) => s.activeTab);
  const zoom = useBrowser((s) => (active ? (s.zoom[active] ?? s.defaultZoom) : s.defaultZoom));
  const defaultZoom = useBrowser((s) => s.defaultZoom);
  const zoomStep = useBrowser((s) => s.zoomStep);
  if (Math.abs(zoom - defaultZoom) < 0.001) return null;
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

/**
 * Shown only while live subtitles run on the current tab. The dialog closes
 * itself once a session starts, so without this there is nothing in the
 * chrome to say captions are on or to stop them; a click reopens the dialog.
 */
function SubtitlesIndicator() {
  const active = useSubtitles((s) => s.active || s.starting);
  const open = useBrowser((s) => s.open.subtitles);
  const toggle = useBrowser((s) => s.toggle);
  if (!active) return null;
  return <IconButton icon={Captions} label="Live subtitles on" shortcut="⌘⇧U" active={!open} onClick={() => toggle("subtitles", true)} />;
}

/** Shown while steps are being recorded in the current tab; a click stops and opens the spec. */
function RecorderIndicator() {
  const recording = useRecorder((s) => s.recordingTab !== null);
  if (!recording) return null;
  return <IconButton icon={ScrollText} label="Stop recording steps" active onClick={() => runCommand("recorder.toggle")} />;
}
