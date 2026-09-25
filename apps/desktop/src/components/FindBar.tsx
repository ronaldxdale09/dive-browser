import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FOCUS_FIND } from "../lib/commands";
import { ipc } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { IconButton } from "./Icon";

/** Cmd+F bar: live count, Enter / Shift+Enter to step, Esc to close. */
export function FindBar() {
  const activeTab = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const sleeping = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? s.tabs.find((t) => t.id === id)?.state === "discarded" : false;
  });
  const toggle = useBrowser((s) => s.toggle);
  // The page is a native view that paints above the chrome, so a panel over
  // it is invisible until the native mask is told where to let the chrome
  // through -- and that mask only runs while something holds a cover. This
  // does not hide the page: with a live overlay registered the tab view
  // stays shown and the mask simply cuts a hole the shape of the panel, the
  // way the agent dock floats over a live page.
  useCoversContent(true);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(1);
  const [result, setResult] = useState({ total: 0, current: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // ⌘F with the bar already open: back to the field, query selected so
    // typing replaces it, as in every browser.
    const refocus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener(FOCUS_FIND, refocus);
    return () => window.removeEventListener(FOCUS_FIND, refocus);
  }, []);

  const idle = !activeTab || sleeping;
  const shown = idle ? { total: 0, current: 0 } : result;

  useEffect(() => {
    if (!activeTab || sleeping) return;
    let alive = true;
    const t = setTimeout(() => {
      ipc
        .tabFind(activeTab, query, index)
        .then((r) => alive && setResult(r))
        .catch(() => alive && setResult({ total: 0, current: 0 }));
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [activeTab, query, index, sleeping]);

  const close = () => {
    if (activeTab) {
      void ipc.tabFind(activeTab, "", 1).catch(() => undefined);
      // The bar took the keyboard; hand it back so the page scrolls with the keys again.
      void ipc.tabFocus(activeTab).catch(() => undefined);
    }
    toggle("find", false);
  };

  // The bar gets its own row above the page: it cannot be drawn over the
  // content area, because that is a native webview painting above the chrome.
  return (
    // Floating: no ground of its own and no full-width strip, so it reads as
    // a panel over the page instead of another bar bolted under the toolbar.
    <div data-native-overlay className="flex items-center">
      <div className="surface-enter flex h-9 items-center gap-1 rounded-full border border-line-2 bg-surface/95 px-2 shadow-2xl backdrop-blur-xl">
        <input
          ref={inputRef}
          aria-label="Find in page"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "Enter") setIndex((i) => (e.shiftKey ? i - 1 : i + 1));
          }}
          placeholder="Find in page"
          className="h-7 w-52 bg-transparent px-2 text-xs outline-none placeholder:text-ink-3"
        />
        <span role="status" aria-live="polite" aria-label={!activeTab ? undefined : sleeping ? "This tab is sleeping" : query ? (shown.total ? `Match ${shown.current} of ${shown.total}` : "No matches") : undefined} className="w-14 text-center font-mono text-[11px] text-ink-3 tabular-nums">
          {idle || !query ? "" : `${shown.current}/${shown.total}`}
        </span>
        <IconButton icon={ChevronUp} label="Previous match" size={13} disabled={!shown.total} onClick={() => setIndex((i) => i - 1)} />
        <IconButton icon={ChevronDown} label="Next match" size={13} disabled={!shown.total} onClick={() => setIndex((i) => i + 1)} />
        <IconButton icon={X} label="Close find" size={13} onClick={close} />
      </div>
    </div>
  );
}
