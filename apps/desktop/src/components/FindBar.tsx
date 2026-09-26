import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FIND_STEP, FOCUS_FIND } from "../lib/commands";
import { ipc } from "../lib/ipc";
import type { FindResult } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { IconButton } from "./Icon";

const NONE: FindResult = { total: 0, current: 0 };

/**
 * What was last searched for. Reopening the bar, or ⌘G with it closed,
 * picks the search up again, as every browser's find does.
 */
let lastQuery = "";

/** Forget the remembered search; for tests. */
export function resetFindQuery() {
  lastQuery = "";
}

/**
 * Cmd+F bar: live count, Enter / Shift+Enter (and ⌘G / ⇧⌘G) to step, Esc to
 * close. A detached window names its tab; the main window searches its
 * active one. The engine's own find does the searching: every match is
 * highlighted, text split across elements and frames is found, and the
 * page's selection is left alone.
 */
export function FindBar({ tabId }: { tabId?: string }) {
  const windowTab = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const activeTab = tabId ?? windowTab;
  const sleeping = useBrowser((s) => (activeTab ? s.tabs.find((t) => t.id === activeTab)?.state === "discarded" : false));
  // A page that navigated has none of the old highlights; the search runs
  // again once the new page has loaded.
  const url = useBrowser((s) => (activeTab ? (s.tabs.find((t) => t.id === activeTab)?.url ?? "") : ""));
  const loading = useBrowser((s) => (activeTab ? s.loading[activeTab] === true : false));
  const toggle = useBrowser((s) => s.toggle);
  // The page is a native view that paints above the chrome, so a panel over
  // it is invisible until the native mask is told where to let the chrome
  // through -- and that mask only runs while something holds a cover. This
  // does not hide the page: with a live overlay registered the tab view
  // stays shown and the mask simply cuts a hole the shape of the panel, the
  // way the agent dock floats over a live page.
  useCoversContent(true);
  const [query, setQuery] = useState(lastQuery);
  const [result, setResult] = useState<FindResult>(NONE);
  const inputRef = useRef<HTMLInputElement>(null);
  // Answers can come back out of order; only the newest request's is shown.
  const sequence = useRef(0);
  // A fresh search waiting out the typing debounce. A step cancels it, or
  // the step's answer would be overtaken by a search from the top.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const idle = !activeTab || sleeping;
  // An emptied field has nothing found, whatever the last answer was.
  const shown = idle || !query ? NONE : result;

  const search = (tab: string, text: string, forward: boolean, next: boolean) => {
    const n = ++sequence.current;
    ipc
      .tabFind(tab, text, forward, next)
      .then((r) => n === sequence.current && setResult(r))
      .catch(() => n === sequence.current && setResult(NONE));
  };

  // Stepping is immediate, held Enter included: each press is one step.
  const step = (forward: boolean) => {
    if (!activeTab || sleeping || !query) return;
    if (pending.current) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    search(activeTab, query, forward, true);
  };
  // ⌘G arrives as a window event; it steps with the bar's current search.
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });

  useEffect(() => {
    inputRef.current?.focus();
    // ⌘F with the bar already open: back to the field, query selected so
    // typing replaces it, as in every browser.
    const refocus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const onStep = (e: Event) => stepRef.current((e as CustomEvent<{ forward: boolean }>).detail?.forward !== false);
    window.addEventListener(FOCUS_FIND, refocus);
    window.addEventListener(FIND_STEP, onStep);
    return () => {
      window.removeEventListener(FOCUS_FIND, refocus);
      window.removeEventListener(FIND_STEP, onStep);
    };
  }, []);

  // A fresh search from the top whenever the query, the tab or its page changes.
  useEffect(() => {
    if (!activeTab || sleeping || loading) return;
    if (!query) {
      sequence.current += 1;
      void ipc.tabFind(activeTab, "", true, false).catch(() => undefined);
      return;
    }
    pending.current = setTimeout(() => {
      pending.current = null;
      search(activeTab, query, true, false);
    }, 80);
    return () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [activeTab, query, url, loading, sleeping]);

  // Leaving a tab -- switching to another, or closing the bar -- takes the
  // highlights off the page it leaves.
  useEffect(() => {
    if (!activeTab || sleeping) return;
    const tab = activeTab;
    return () => {
      sequence.current += 1;
      void ipc.tabFind(tab, "", true, false).catch(() => undefined);
    };
  }, [activeTab, sleeping]);

  const close = () => {
    // The bar took the keyboard; hand it back so the page scrolls with the keys again.
    if (activeTab) void ipc.tabFocus(activeTab).catch(() => undefined);
    toggle("find", false);
  };

  const spoken = !activeTab ? "" : sleeping ? "This tab is sleeping" : query ? (shown.total ? `Match ${shown.current} of ${shown.total}` : "No matches") : "";

  // The bar gets its own row above the page: it cannot be drawn over the
  // content area, because that is a native webview painting above the chrome.
  return (
    // Floating: no ground of its own and no full-width strip, so it reads as
    // a panel over the page instead of another bar bolted under the toolbar.
    <div className="flex items-center">
      {/* The mark is on the pill, not its wrapper: the native mask takes the
          marked element's rectangle and corner radius, and a square wrapper
          showed the chrome's dark background in the corners around the pill. */}
      <div data-native-overlay className="surface-enter flex h-9 items-center gap-1 rounded-full border border-line-2 bg-surface/95 px-2 shadow-2xl backdrop-blur-xl">
        <input
          ref={inputRef}
          aria-label="Find in page"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            lastQuery = e.target.value;
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              close();
              return;
            }
            if (e.key !== "Enter") return;
            // Enter while an input method is composing confirms the
            // composition; it is not a request for the next match.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            step(!e.shiftKey);
          }}
          placeholder="Find in page"
          className="h-7 w-52 bg-transparent px-2 text-xs outline-none placeholder:text-ink-3"
        />
        <span aria-hidden="true" className="w-14 text-center font-mono text-[11px] text-ink-3 tabular-nums">
          {idle || !query ? "" : `${shown.current}/${shown.total}`}
        </span>
        {/* Read out as words: an aria-label on a live region is not what
            screen readers announce when it changes, its text is. */}
        <span role="status" aria-live="polite" className="sr-only">
          {spoken}
        </span>
        <IconButton icon={ChevronUp} label="Previous match" size={13} disabled={!shown.total} onClick={() => step(false)} />
        <IconButton icon={ChevronDown} label="Next match" size={13} disabled={!shown.total} onClick={() => step(true)} />
        <IconButton icon={X} label="Close find" size={13} onClick={close} />
      </div>
    </div>
  );
}
