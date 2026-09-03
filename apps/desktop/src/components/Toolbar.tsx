import { ArrowLeft, ArrowRight, Bug, Camera, Lock, PanelBottom, RotateCw, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { useBrowser } from "../store/browser";
import { selectErrorCount, useConsole } from "../store/console";
import { Icon, IconButton } from "./Icon";
import { DeviceMenu } from "./DeviceMenu";
import { SharePopover } from "./SharePopover";
import { BookmarkButton } from "./BookmarkButton";

/** Navigation row: nav icons, the omnibox pill, page actions, dock and agent toggles. */
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
  const errorCount = useConsole(selectErrorCount(activeTab));
  const url = current?.url ?? "";
  // Reset the draft whenever the active tab's URL changes (adjust-state-during-render).
  const [draft, setDraft] = useState({ url, value: url });
  if (draft.url !== url) setDraft({ url, value: url });
  const value = draft.value;
  const setValue = (v: string) => setDraft({ url, value: v });
  const secure = url.startsWith("https://");
  const display = pretty(url);

  return (
    <div className="flex h-full items-center gap-1 px-2">
      <IconButton icon={ArrowLeft} label="Back" disabled={!current} onClick={() => void back()} />
      <IconButton icon={ArrowRight} label="Forward" disabled={!current} onClick={() => void forward()} />
      <IconButton icon={RotateCw} label="Reload" disabled={!current} onClick={() => void reload()} size={14} />
      <form
        className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition-colors focus-within:border-line-2 focus-within:bg-surface-2"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate(value);
        }}
      >
        <Icon icon={current ? (secure ? Lock : Search) : Search} size={13} className="shrink-0 text-ink-3" />
        <input
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
      <IconButton icon={Camera} label="Capture full page" disabled={!current} onClick={() => void capture(true)} />
      <DeviceMenu />
      <IconButton icon={Bug} label="Open DevTools" disabled={!current} onClick={() => void devtools()} />
      <span className="mx-1 h-4 w-px bg-line-2" aria-hidden />
      <IconButton icon={PanelBottom} label="Developer dock" active={open.dock} onClick={() => toggle("dock")} />
      <button
        type="button"
        aria-pressed={open.sidecar}
        onClick={() => toggle("sidecar")}
        className={`ml-1 flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors ${
          open.sidecar ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <Icon icon={Sparkles} size={14} />
        Agent
        {errorCount > 0 && !open.sidecar && (
          <span className="ml-0.5 rounded-full bg-danger px-1.5 py-px font-mono text-[10px] leading-4 text-white" aria-label={`${errorCount} errors`}>
            {errorCount > 99 ? "99+" : errorCount}
          </span>
        )}
      </button>
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
    <button
      type="button"
      title="Reset zoom"
      onClick={() => void zoomStep(0)}
      className="mr-1 h-6 rounded-full border border-line px-2 font-mono text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      {Math.round(zoom * 100)}%
    </button>
  );
}
