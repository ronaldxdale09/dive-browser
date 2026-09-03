import { ArrowLeft, ArrowRight, Bug, Camera, Lock, PanelBottom, RotateCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FOCUS_ADDRESS } from "../lib/commands";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";
import { SharePopover } from "./SharePopover";
import { BookmarkButton } from "./BookmarkButton";
import { DownloadsMenu } from "./DownloadsMenu";
import { ProtectionMenu } from "./ProtectionMenu";
import { Tooltip } from "./Tooltip";

/** Navigation row: nav icons, the omnibox pill and, as glyphs, the actions that act on the page. */
export function Toolbar() {
  const tabs = useBrowser((s) => s.tabs);
  const activeTab = useBrowser((s) => s.activeTab);
  const navigate = useBrowser((s) => s.navigate);
  const back = useBrowser((s) => s.back);
  const forward = useBrowser((s) => s.forward);
  const reload = useBrowser((s) => s.reload);
  const capture = useBrowser((s) => s.capture);
  const devtools = useBrowser((s) => s.devtools);
  const toggle = useBrowser((s) => s.toggle);
  const open = useBrowser((s) => s.open);
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
  // Cmd+L, from the menu or the palette.
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener(FOCUS_ADDRESS, focus);
    return () => window.removeEventListener(FOCUS_ADDRESS, focus);
  }, []);

  return (
    <div className="flex h-full items-center gap-1 px-2">
      <IconButton icon={ArrowLeft} label="Back" disabled={!current} onClick={() => void back()} />
      <IconButton icon={ArrowRight} label="Forward" disabled={!current} onClick={() => void forward()} />
      <IconButton icon={RotateCw} label="Reload" shortcut="⌘R" disabled={!current} onClick={() => void reload()} size={14} />
      <form
        className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2"
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
      <ZoomBadge />
      <BookmarkButton />
      <SharePopover />
      <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
      <IconButton icon={Camera} label="Capture full page" shortcut="⌘⇧S" disabled={!current} onClick={() => void capture(true)} />
      <IconButton icon={Bug} label="Open DevTools" shortcut="⌘⌥I" disabled={!current} onClick={() => void devtools()} />
      <IconButton icon={PanelBottom} label="Developer dock" shortcut="⌘⇧D" active={open.dock} onClick={() => toggle("dock")} />
      <DownloadsMenu compact />
      <ProtectionMenu compact />
    </div>
  );
}

/** Hostname plus path, scheme dropped, for the resting omnibox. */
function pretty(url: string) {
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
