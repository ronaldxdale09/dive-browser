import { ChevronDown, Plus, X } from "lucide-react";
import { useBrowser } from "../store/browser";
import type { Tab } from "../lib/ipc";
import { Icon, IconButton } from "./Icon";
import { Favicon } from "./Favicon";

function label(t: Tab) {
  if (t.title) return t.title;
  try {
    return new URL(t.url).host || t.url;
  } catch {
    return t.url;
  }
}

/** Comet-style top strip: pill tabs, plus button, overflow chevron on the right. */
export function TabStrip() {
  const all = useBrowser((s) => s.tabs);
  const active = useBrowser((s) => s.activeTab);
  const activate = useBrowser((s) => s.activateTab);
  const close = useBrowser((s) => s.closeTab);
  const toggle = useBrowser((s) => s.toggle);
  const tabs = all.filter((t) => t.tier !== "essential" && t.state !== "discarded");

  return (
    <div className="flex h-full items-center gap-1 pr-2 pl-2" data-tauri-drag-region>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" role="tablist">
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => void activate(t.id)}
              onKeyDown={(e) => e.key === "Enter" && void activate(t.id)}
              onAuxClick={(e) => e.button === 1 && void close(t.id)}
              className={`group flex h-8 max-w-56 min-w-28 items-center gap-2 rounded-lg px-2.5 text-xs transition-colors ${
                isActive ? "bg-surface-2 text-ink ring-1 ring-line-2" : "text-ink-2 hover:bg-surface hover:text-ink"
              }`}
            >
              <Favicon tab={t} size={14} />
              <span className="truncate">{label(t)}</span>
              <button
                type="button"
                aria-label={`Close ${label(t)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void close(t.id);
                }}
                className="ml-auto grid size-5 shrink-0 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface-3 hover:text-ink group-hover:opacity-100 aria-selected:opacity-100"
              >
                <Icon icon={X} size={12} />
              </button>
            </div>
          );
        })}
        <IconButton icon={Plus} label="New tab" onClick={() => toggle("palette", true)} />
      </div>
      <IconButton icon={ChevronDown} label="All tabs" onClick={() => toggle("palette", true)} size={14} />
    </div>
  );
}
