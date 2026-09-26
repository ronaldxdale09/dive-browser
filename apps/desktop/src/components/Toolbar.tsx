import { isPrivateWindow } from "../lib/privateMode";
import { prettyUrl, splitAddress } from "../lib/prettyUrl";
import { Captions, FileText, Globe, House, Info, ScrollText, Lock, MoreHorizontal, RotateCw, Search, TriangleAlert, X, Menu } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FOCUS_ADDRESS } from "../lib/commands";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { SharePopover } from "./SharePopover";
import { BookmarkButton } from "./BookmarkButton";
import { PageActions } from "./PageActions";
import { AddressSuggestions, optionId, useAddressSuggestions } from "./AddressSuggestions";
import { opensInAnotherApp, searchWords } from "../lib/omnibox";
import type { Suggestion } from "../lib/omnibox";
import { ipc } from "../lib/ipc";
import type { Tab } from "../lib/ipc";
import { DownloadsMenu } from "./DownloadsMenu";
import { useDownloads } from "../store/downloads";
import { ProtectionMenu } from "./ProtectionMenu";
import { InstallAppButton } from "./InstallAppButton";
import { MainMenu } from "./MainMenu";
import { Tooltip } from "./Tooltip";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useDismiss } from "../lib/useDismiss";
import { useSubtitles } from "../store/subtitles";
import { useRecorder } from "../store/recorder";
import { runCommand } from "../lib/commands";
import { usePrefs } from "../store/prefs";
import { NavigationButtons } from "./NavigationButtons";
import { ADDRESS_SECURITY_MEANING, addressSecurity } from "../lib/addressSecurity";
import type { AddressSecurity } from "../lib/addressSecurity";

const SECURITY_GLYPHS: Record<AddressSecurity, LucideIcon> = {
  none: Search,
  failed: TriangleAlert,
  secure: Lock,
  plain: Globe,
  internal: Info,
  file: FileText,
  local: Info,
};

const NO_TABS: Tab[] = [];

/** How long a submitted address waits for its load to begin before the bar stops showing it. */
const PENDING_START_MS = 2000;

/**
 * Text being typed over a tab. `base` is the address it was started on, so a
 * new page arriving while the field is not focused ends it; `initial` is what
 * the field held on focus; `complete` says the last edit was typing at the
 * end, the only time an address is completed in place.
 */
type Draft = { tabId: string | null; value: string; base: string; initial: string; complete: boolean };

/** Text submitted over a tab whose load has not committed; `started` once the load began. */
type Pending = { tabId: string; text: string; base: string; started: boolean };

function freshDraft(tabId: string | null, value: string, base = value): Draft {
  return { tabId, value, base, initial: value, complete: false };
}

/** A key press that belongs to an input method composing text, not to the bar. */
function composing(event: React.KeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** Navigation row: nav icons, the omnibox pill and, as glyphs, the actions that act on the page. */
export function Toolbar({ compact = false, trailing = true }: { compact?: boolean; singleAuxPanel?: boolean; /** Render the browser's own controls (downloads, privacy, menu) at the end; off when the bar places them after the feature cluster. */ trailing?: boolean }) {
  const activeTab = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const navigate = useBrowser((s) => s.navigate);
  const activateTab = useBrowser((s) => s.activateTab);
  const reload = useBrowser((s) => s.reload);
  const stop = useBrowser((s) => s.stop);
  const homepage = usePrefs((s) => s.prefs.homepage.trim());
  const loading = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? s.loading[id] === true : false;
  });
  // The active tab, not the list: a background tab's title or favicon
  // changing must not re-render the address bar.
  const current = useBrowser((s) => s.tabs.find((t) => t.id === activeTab));
  const failedUrl = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? s.navError[id]?.url : undefined;
  });
  // A load that failed leaves the bar on the address that failed, as every
  // browser does, so it can be corrected in place; the store still holds the
  // last committed URL for everything else.
  const url = failedUrl || current?.url || "";
  // What is being typed. A redirect must not overwrite it, and neither must
  // leaving the app for a moment: the field losing focus to another window,
  // or to the page, keeps the draft until a new page arrives in that tab. A
  // tab switch does reset it, even when both tabs have the same URL.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [focused, setFocused] = useState(false);
  if (draft && draft.tabId !== activeTab) setDraft(focused ? freshDraft(activeTab, url) : null);
  const editing = draft !== null && draft.tabId === activeTab && (focused || draft.base === url);
  const typed = editing ? draft.value : "";
  // What was submitted, shown at rest until its page commits. The tab's own
  // URL is only ever the engine's, so a load that never commits -- a
  // download, a stop, a refusal -- puts the bar back by itself.
  // It is measured against the committed address, not a failed one the bar
  // may be showing: submitting clears that failure at once.
  const committed = current?.url ?? "";
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingText = !editing && pending && pending.tabId === activeTab && pending.base === committed && !failedUrl ? pending.text : null;
  const failed = Boolean(failedUrl);
  const display = prettyUrl(url);
  const inputRef = useRef<HTMLInputElement>(null);
  // Suggestions live only while the draft says something other than what the
  // field held when it was focused -- focusing the bar selects the URL, and
  // that alone is not a question. The list is a listbox the input drives, so
  // the input never loses focus to it.
  const listId = useId();
  // Open tabs are offered only while typing, so only then is the list followed.
  const tabs = useBrowser((s) => (editing ? s.tabs : NO_TABS));
  const asking = editing && focused && typed.trim() !== url && typed !== draft.initial;
  const { rows, highlight, setHighlight, move, remove, completion } = useAddressSuggestions(typed, asking, tabs, { activeTab, autocomplete: draft?.complete === true });
  const shown = editing ? (completion ?? typed) : (pendingText ?? display);
  const resting = !editing && !pendingText && Boolean(current && display);
  const finishEditing = () => {
    setDraft(null);
    inputRef.current?.blur();
  };
  // Load `target` in this tab, showing `text` in the bar until it commits.
  const go = (target: string, text = target) => {
    finishEditing();
    const tabId = activeTab;
    const entry = tabId && !opensInAnotherApp(target) ? { tabId, text, base: committed, started: false } : null;
    setPending(entry);
    void navigate(target).then((accepted) => {
      if (!accepted) setPending((now) => (now === entry ? null : now));
    });
  };
  const pick = (row: Suggestion) => {
    if (row.kind === "tab") {
      finishEditing();
      void activateTab(row.tabId);
    } else if (row.kind === "suggest") {
      // The engine's phrases are searches, whatever they look like.
      go(`?${row.url}`, row.url);
    } else go(row.url);
  };
  // The page's own load says when the submitted text has had its turn: once
  // a load has started and stopped without a new address, or when none has
  // started at all within a moment, the bar shows the tab's address again.
  if (pending && (pending.tabId !== activeTab || pending.base !== committed || failedUrl || (pending.started && !loading))) setPending(null);
  else if (pending && loading && !pending.started) setPending({ ...pending, started: true });
  useEffect(() => {
    if (!pending || pending.started) return;
    const timer = setTimeout(() => setPending((now) => (now === pending ? null : now)), PENDING_START_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  // Completion is drawn selected after the caret, so the next letter typed
  // replaces it and Backspace takes it away.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (completion && input && document.activeElement === input) input.setSelectionRange(typed.length, completion.length);
  }, [completion, typed]);
  // A click that focuses the field selects all of it; this remembers that
  // the press began outside so the mouseup that ends it can keep that.
  const selectOnMouseUp = useRef(false);
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
      {/* The address takes the room the bar has. A cap tight enough to look
          considered on a 27-inch display leaves a stripe of nothing between
          the address and the buttons on a laptop, which reads as a layout
          bug rather than as restraint -- so the limit is set where a line of
          text genuinely stops being readable, and the fixed gutter after it
          is what the window is picked up by. */}
      <div data-address-field className="relative mx-1 flex h-[calc(var(--row-h)-4px)] min-w-0 max-w-[80rem] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!typed.trim()) return;
            const row = rows[highlight];
            if (row) {
              pick(row);
              return;
            }
            go(typed);
          }}
        >
          {/* The glyph says what kind of thing the bar holds: a search when
              it is empty, a lock for https, a globe for plain http, a warning
              for a page that did not load, and for Dive's own pages and local
              files what they are rather than a false "not secure". Each
              explains itself on hover. */}
          {(() => {
            const kind = addressSecurity(url, { failed, hasTab: Boolean(current) });
            const glyph = SECURITY_GLYPHS[kind];
            const meaning = ADDRESS_SECURITY_MEANING[kind];
            return (
              <Tooltip label={meaning} side="bottom" align="start">
                <span role="img" aria-label={meaning} data-security={kind === "plain" ? "none" : kind} className="grid shrink-0 place-items-center">
                  <Icon icon={glyph} size={13} className={kind === "failed" ? "text-warn" : "text-ink-3"} />
                </span>
              </Tooltip>
            );
          })()}
          {/* The input and the text drawn over it share one box, so the resting
              address ends exactly where the field does -- before the actions in
              the pill rather than underneath them. */}
          <span className="relative flex min-w-0 flex-1 items-center">
          {/* At rest the host is set in ink and the path in a quieter tone, so a
              glance reads the site; the input underneath keeps the whole text
              for selection, copying and assistive tech. */}
          {resting && (
            <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden text-[13px] whitespace-nowrap">
              <span className="text-ink">{splitAddress(url).host}</span>
              <span className="truncate text-ink-3">{splitAddress(url).rest}</span>
            </span>
          )}
          <input
            ref={inputRef}
            aria-label="Address"
            title={resting ? display : undefined}
            value={shown}
            onChange={(event) => {
              const input = event.currentTarget;
              const native = event.nativeEvent as InputEvent;
              // Completing in place follows typing at the end, and nothing
              // else: not a deletion, which would put back what was just
              // removed, and not a composition still being chosen.
              const complete = !native.inputType?.startsWith("delete") && !native.isComposing && input.selectionEnd === input.value.length;
              setDraft({ ...(editing ? draft : freshDraft(activeTab, url)), value: input.value, complete });
            }}
            onFocus={() => {
              setFocused(true);
              // Coming back to a draft left a moment ago keeps it, caret and all.
              if (!editing) setDraft(freshDraft(activeTab, pendingText ?? url, url));
            }}
            onBlur={() => {
              setFocused(false);
              // Focus moving within the chrome ends the edit. The window
              // losing it -- to another app, or to the page -- does not.
              if (document.hasFocus() || !draft || draft.value === draft.initial) setDraft(null);
            }}
            onMouseDown={(event) => {
              selectOnMouseUp.current = document.activeElement !== event.currentTarget;
            }}
            onMouseUp={(event) => {
              if (!selectOnMouseUp.current) return;
              selectOnMouseUp.current = false;
              // The press that focused the field selected all of it; the
              // mouseup that ends the click would collapse that to a caret.
              // A press that dragged out a range of its own keeps it.
              const input = event.currentTarget;
              if (input.selectionStart === input.selectionEnd) {
                event.preventDefault();
                input.select();
              }
            }}
            onKeyDown={(event) => {
              if (composing(event)) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                // The first Escape takes back what was typed and keeps the
                // field; the next hands the keyboard back to the page.
                if (editing && (draft.value !== url || completion)) {
                  const input = event.currentTarget;
                  flushSync(() => setDraft(freshDraft(activeTab, url)));
                  input.select();
                  return;
                }
                finishEditing();
                if (activeTab) void ipc.tabFocus(activeTab).catch(() => undefined);
                return;
              }
              if (event.key === "Enter" && event.altKey) {
                // Option-Enter searches for the words, whatever they look like.
                event.preventDefault();
                const words = searchWords(typed);
                if (words) go(`?${words}`, words);
                return;
              }
              if (completion && !event.shiftKey && (event.key === "ArrowRight" || event.key === "End")) {
                // Moving past the completion accepts it as typed text.
                setDraft({ ...draft!, value: completion, complete: false });
                return;
              }
              if (event.key === "Delete" && event.shiftKey) {
                const row = rows[highlight];
                if (row && remove(row)) event.preventDefault();
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
            aria-autocomplete="both"
            aria-controls={rows.length > 0 ? listId : undefined}
            aria-activedescendant={rows.length > 0 ? optionId(listId, highlight) : undefined}
            className={`min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3 ${resting ? "text-transparent" : "text-ink"}`}
          />
          </span>
          <AddressSuggestions id={listId} rows={rows} highlight={highlight} onHighlight={setHighlight} onPick={pick} />
        </form>
        {/* Inside the pill, at its right edge, as Brave and Chrome keep
            them: what this page can become (an installed app), what is being
            done to it (protection) and what you can do with it (save it,
            send it). They belong to the address they sit on, and out here
            they read as browser controls instead. */}
        <span className="ml-1 flex shrink-0 items-center gap-0.5">
          <PageActions />
          <InstallAppButton />
          <ProtectionMenu compact />
          {!isPrivateWindow() && <BookmarkButton />}
          <SharePopover />
        </span>
      </div>
      {compact ? (
        <ToolbarMore>
          <ZoomBadge />
          <SubtitlesIndicator />
          <RecorderIndicator />
          <DownloadsIndicator />
        </ToolbarMore>
      ) : (
        <>
          {/* Beside the address: what is happening to the page rather than
              what acts on it -- zoom, subtitles, a recording of steps, a
              download. Everything else lives in Apps. */}
          <ZoomBadge />
          <SubtitlesIndicator />
          <RecorderIndicator />
          <DownloadsIndicator />
        </>
      )}
      {/* A strip that is always there to pick the window up by, whatever the
          address did with the rest of the row. */}
      <span aria-hidden data-tauri-drag-region="true" className="w-10 shrink-0 self-stretch" />
      {trailing && <BrowserActions />}
      {loading && <LoadingLine />}
    </div>
  );
}

/**
 * The control that is about the browser rather than the page: the menu. It
 * closes the bar, whichever bar that is, so it is always in the corner where
 * every browser keeps it. Protection moved beside the address, since it is
 * about the page in front of you.
 */
export function BrowserActions() {
  const open = useBrowser((s) => s.open);
  const toggle = useBrowser((s) => s.toggle);
  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <IconButton icon={Menu} label="Menu" active={open.menu} hasPopup="dialog" expanded={open.menu} onClick={() => toggle("menu")} tooltipAlign="end" />
      {open.menu && <MainMenu />}
    </div>
  );
}

/**
 * Secondary page actions collapse into a small tray before the omnibox does.
 * Every one of them shows only while it has something to say, so with none
 * of them showing there is no tray: a More button that opens onto an empty
 * box reads as broken.
 */
function ToolbarMore({ children }: { children: React.ReactNode }) {
  const [wanted, setOpen] = useState(false);
  const any = useAnyPageStatus();
  const open = wanted && any;
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open, onEscape: () => setOpen(false) });
  // Closes on a press outside, Escape, focus elsewhere, and a click on the
  // page (seen only as the window losing focus).
  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(root, open, dismiss);
  if (!any) return null;
  return (
    <div ref={root} className="relative shrink-0">
      <IconButton icon={MoreHorizontal} label="More page actions" active={open} hasPopup="dialog" expanded={open} onClick={() => setOpen(!open)} tooltipAlign="end" />
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

type BrowserSnapshot = ReturnType<typeof useBrowser.getState>;

/** The active tab is awake and zoomed away from the default. */
function zoomBadgeShown(s: BrowserSnapshot) {
  const id = tabInThisWindow(s.activeTab, s.detached);
  if (!id || s.tabs.find((t) => t.id === id)?.state === "discarded") return false;
  return Math.abs((s.zoom[id] ?? s.defaultZoom) - s.defaultZoom) >= 0.001;
}

/**
 * Whether any of the indicators beside the address has something to show.
 * Each indicator decides for itself with the same rules; this is how the
 * compact tray knows it would be empty.
 */
function useAnyPageStatus() {
  const zoomed = useBrowser(zoomBadgeShown);
  const subtitles = useSubtitles((s) => s.active || s.starting);
  const downloads = useDownloads((s) => s.items.length > 0);
  const recordingTab = useRecorder((s) => s.recordingTab);
  const here = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  return zoomed || subtitles || downloads || (recordingTab !== null && recordingTab === here);
}

/** Shows the active tab's zoom when it is not the default; click resets. */
function ZoomBadge() {
  const shown = useBrowser(zoomBadgeShown);
  const zoom = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? (s.zoom[id] ?? s.defaultZoom) : s.defaultZoom;
  });
  const zoomStep = useBrowser((s) => s.zoomStep);
  if (!shown) return null;
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

/**
 * Downloads sit in the bar only while there is something to show: a file
 * saving, or ones saved this session. Otherwise the Library has them.
 */
function DownloadsIndicator() {
  const any = useDownloads((s) => s.items.length > 0);
  if (!any) return null;
  return <DownloadsMenu compact />;
}

/** Shown while steps are being recorded in the current tab; a click stops and opens the spec. */
function RecorderIndicator() {
  const recordingTab = useRecorder((s) => s.recordingTab);
  const here = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  if (!recordingTab || recordingTab !== here) return null;
  return <IconButton icon={ScrollText} label="Stop recording steps" active toggle onClick={() => runCommand("recorder.toggle")} />;
}
