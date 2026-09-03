import { selectStrip, useBrowser } from "../store/browser";
import type { Tab } from "../lib/ipc";

function label(t: Tab) {
  if (t.title) return t.title;
  try {
    return new URL(t.url).host || t.url;
  } catch {
    return t.url;
  }
}

export function TabStrip() {
  const { pinned, today } = useBrowser(selectStrip);
  const active = useBrowser((s) => s.activeTab);
  const activate = useBrowser((s) => s.activateTab);
  const close = useBrowser((s) => s.closeTab);
  const toggle = useBrowser((s) => s.toggle);
  const tabs = [...pinned, ...today];

  return (
    <div className="flex h-full items-end gap-1 px-2 pt-2" data-tauri-drag-region>
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
            className={`group flex h-7 max-w-52 min-w-24 items-center gap-2 rounded-t-md border border-b-0 px-2.5 text-xs ${
              isActive ? "border-line-2 bg-surface text-ink" : "border-transparent text-ink-2 hover:bg-surface/60"
            }`}
          >
            <span className="truncate">{label(t)}</span>
            <button
              type="button"
              aria-label={`Close ${label(t)}`}
              onClick={(e) => {
                e.stopPropagation();
                void close(t.id);
              }}
              className="ml-auto rounded px-1 text-ink-3 opacity-0 hover:bg-surface-2 hover:text-ink group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New tab"
        onClick={() => toggle("palette", true)}
        className="mb-0.5 grid size-6 place-items-center rounded text-ink-2 hover:bg-surface"
      >
        +
      </button>
    </div>
  );
}
