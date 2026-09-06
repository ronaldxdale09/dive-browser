import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NavigationHistory } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useTabHistory } from "../lib/useTabHistory";
import { useBrowser } from "../store/browser";
import { IconButton } from "./Icon";

export function NavigationButtons({ tabId, url, loading }: { tabId: string | null; url: string; loading: boolean }) {
  const { history, canBack, canForward } = useTabHistory(tabId, url, loading);
  const back = useBrowser((s) => s.back);
  const forward = useBrowser((s) => s.forward);
  return <>
    <HistoryButton key={`back-${tabId}`} direction="back" tabId={tabId} history={history} disabled={!canBack} navigate={back} />
    <HistoryButton key={`forward-${tabId}`} direction="forward" tabId={tabId} history={history} disabled={!canForward} navigate={forward} />
  </>;
}

function HistoryButton({ direction, tabId, history, disabled, navigate }: {
  direction: "back" | "forward"; tabId: string | null; history: NavigationHistory | null; disabled: boolean; navigate: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (open && disabled) setOpen(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const label = direction === "back" ? "Back" : "Forward";
  const visible = open && !disabled && history !== null;
  useCoversContent(visible);
  useFocusTrap(panel, { active: visible, menu: true, onEscape: () => setOpen(false) });
  useEffect(() => {
    if (!visible) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [visible]);
  const entries = history ? direction === "back" ? history.entries.slice(0, history.current_index).reverse() : history.entries.slice(history.current_index + 1) : [];
  const show = () => {
    if (disabled) return;
    root.current?.querySelector("button")?.focus();
    setOpen(true);
  };
  return <div ref={root} className="relative shrink-0">
    <IconButton icon={direction === "back" ? ArrowLeft : ArrowRight} label={label} disabled={disabled}
      onClick={() => { setOpen(false); void navigate(); }}
      hasPopup="menu" expanded={visible}
      description="Right-click or press Arrow Down to show this tab’s history"
      onContextMenu={(event) => { event.preventDefault(); show(); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); show(); }
      }} />
    {visible && <div ref={panel} role="menu" aria-label={`${label} history`} className="surface-enter absolute left-0 top-full z-50 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-line-2 bg-surface p-1 shadow-2xl">
      {entries.map((entry) => <button type="button" role="menuitem" key={entry.id} title={entry.url}
        className="block w-full rounded-lg px-3 py-2 text-left text-ink-2 hover:bg-surface-2 focus:bg-surface-2 focus:text-ink focus:outline-none"
        onClick={() => {
          setOpen(false);
          if (tabId && history) void ipc.tabHistoryNavigate(tabId, history.generation, entry.id).catch((error: unknown) => {
            useBrowser.setState({ error: error instanceof Error ? error.message : String(error) });
          });
        }}>
        <span className="block truncate text-[12px]">{entry.title.trim() || entry.url}</span>
        <span className="block truncate text-[10px] text-ink-3">{entry.url}</span>
      </button>)}
    </div>}
  </div>;
}
