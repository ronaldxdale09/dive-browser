import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { NavigationHistory } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useDismiss } from "../lib/useDismiss";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useTabHistory } from "../lib/useTabHistory";
import { useBrowser } from "../store/browser";
import { IconButton } from "./Icon";
import { errorMessage } from "../lib/errors";

export function NavigationButtons({ tabId, url }: { tabId: string | null; url: string }) {
  const { canBack, canForward, loadHistory } = useTabHistory(tabId, url);
  const back = useBrowser((s) => s.back);
  const forward = useBrowser((s) => s.forward);
  return <>
    <HistoryButton key={`back-${tabId}`} direction="back" tabId={tabId} loadHistory={loadHistory} disabled={!canBack} navigate={back} />
    <HistoryButton key={`forward-${tabId}`} direction="forward" tabId={tabId} loadHistory={loadHistory} disabled={!canForward} navigate={forward} />
  </>;
}

function HistoryButton({ direction, tabId, loadHistory, disabled, navigate }: {
  direction: "back" | "forward"; tabId: string | null; loadHistory: () => Promise<NavigationHistory | null>; disabled: boolean; navigate: () => Promise<void>;
}) {
  // The stack as read when the menu opened; read afresh each time it opens.
  const [history, setHistory] = useState<NavigationHistory | null>(null);
  const open = history !== null;
  // Bumped whenever the menu is closed or asked for again, so a read that
  // answers after that does not open a menu nobody is waiting for.
  const request = useRef(0);
  const close = useCallback(() => {
    request.current += 1;
    setHistory(null);
  }, []);
  if (open && disabled) setHistory(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const label = direction === "back" ? "Back" : "Forward";
  const visible = open && !disabled;
  useCoversContent(visible);
  useFocusTrap(panel, { active: visible, menu: true, onEscape: close });
  useDismiss(root, visible, close);
  const entries = history ? direction === "back" ? history.entries.slice(0, history.current_index).reverse() : history.entries.slice(history.current_index + 1) : [];
  const show = () => {
    if (disabled) return;
    root.current?.querySelector("button")?.focus();
    const asked = ++request.current;
    void loadHistory().then((read) => {
      if (read && asked === request.current) setHistory(read);
    });
  };
  return <div ref={root} className="relative shrink-0">
    <IconButton icon={direction === "back" ? ArrowLeft : ArrowRight} label={label} disabled={disabled}
      onClick={() => { close(); void navigate(); }}
      hasPopup="menu" expanded={visible}
      description="Right-click or press Arrow Down to show this tab’s history"
      onContextMenu={(event) => { event.preventDefault(); show(); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); show(); }
      }} />
    {visible && <div ref={panel} role="menu" aria-label={`${label} history`} className="surface-enter absolute left-0 top-full z-50 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-line-2 bg-surface p-1 text-xs shadow-2xl">
      {entries.map((entry) => <button type="button" role="menuitem" key={entry.id} title={entry.url}
        // The pointer and the keyboard share one cursor: hovering a row moves
        // focus to it, so the first item's focus and the hovered row are never
        // two highlighted rows at once.
        onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
        className="block w-full rounded-lg px-2.5 py-1 text-left text-ink-2 outline-none hover:bg-surface-2 hover:text-ink focus-visible:bg-surface-2 focus-visible:text-ink"
        onClick={() => {
          close();
          if (tabId && history) void ipc.tabHistoryNavigate(tabId, history.generation, entry.id).catch((error: unknown) => {
            useBrowser.setState({ error: errorMessage(error) });
          });
        }}>
        <span className="block truncate leading-4">{entry.title.trim() || entry.url}</span>
        <span className="block truncate text-[10.5px] leading-4 text-ink-3">{entry.url}</span>
      </button>)}
    </div>}
  </div>;
}
