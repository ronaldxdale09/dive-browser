import { LayoutGrid, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { APP_CATEGORIES, appsFor, chordOf, launchApp, searchApps } from "../lib/apps";
import type { AppEntry } from "../lib/apps";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { BuildBadge } from "./BuildBadge";
import { AgentIcon } from "./agent/AgentIcon";
import { Icon, IconButton } from "./Icon";

const COLUMNS = 3;

/**
 * The Apps launcher: Dive's tools on one screen, under the shelf each
 * belongs to, with a line on what each is for and the shortcut that
 * reaches it. A person who has never opened a menu can learn the product
 * here; a person who has can type two letters and press Enter. The bar
 * above keeps only the two things used all day, the agent and this.
 */
export function AppsDialog() {
  const toggle = useBrowser((s) => s.toggle);
  const activeTab = useBrowser((s) => s.activeTab);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const { close, className } = useFadeClose(() => toggle("apps", false));
  useCoversContent(true);
  useFocusTrap(root, { initialFocus: field, onEscape: close });
  const [query, setQuery] = useState("");
  const all = useMemo(() => appsFor(), []);
  const shown = useMemo(() => searchApps(all, query), [all, query]);
  // Shelves keep their order; a search just empties the ones nothing matched.
  const shelves = APP_CATEGORIES.map((c) => ({ ...c, apps: shown.filter((a) => a.category === c.id) })).filter((c) => c.apps.length > 0);

  const launch = (app: AppEntry) => {
    close();
    launchApp(app);
  };

  // Arrow keys walk the grid; Enter in the search field opens the first match.
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cards = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("[data-app]:not(:disabled)") ?? []);
    const i = cards.findIndex((c) => c === document.activeElement);
    if (i === -1) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? COLUMNS : e.key === "ArrowUp" ? -COLUMNS : e.key === "Home" ? -i : e.key === "End" ? cards.length - 1 - i : 0;
    if (!step) return;
    const next = cards[Math.max(0, Math.min(cards.length - 1, i + step))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div ref={root} className={`fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-[2px] ${className}`} onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Apps" onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[86vh] w-[780px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="grid size-8 place-items-center rounded-lg bg-accent/15 text-accent">
            <Icon icon={LayoutGrid} size={16} />
          </span>
          <h2 className="text-sm font-semibold">Apps</h2>
          <label className="ml-2 flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 focus-within:border-line-2">
            <Icon icon={Search} size={14} className="text-ink-3" />
            <input
              ref={field}
              aria-label="Search apps"
              placeholder="Search apps…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) {
                  e.preventDefault();
                  launch(shown[0]);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  grid.current?.querySelector<HTMLButtonElement>("[data-app]:not(:disabled)")?.focus();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
            {query && (
              <button type="button" aria-label="Clear" onClick={() => setQuery("")} className="grid size-5 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink">
                <Icon icon={X} size={11} />
              </button>
            )}
          </label>
          <BuildBadge />
          <IconButton icon={X} label="Close apps" onClick={close} />
        </header>
        <div ref={grid} onKeyDown={onGridKey} className="min-h-0 flex-1 overflow-y-auto p-4">
          {shown.length === 0 ? (
            <p className="py-12 text-center text-xs text-ink-3">No app called “{query.trim()}”. Commands like find, print and settings live in the menu and the command palette (⌘K).</p>
          ) : (
            <div className="flex flex-col gap-5">
              {shelves.map((shelf) => (
                <section key={shelf.id} aria-label={shelf.name}>
                  <h3 className="mb-2 px-1 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{shelf.name}</h3>
                  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
                    {shelf.apps.map((app) => (
                      <AppCard key={app.id} app={app} disabled={Boolean(app.needsTab && !activeTab)} onLaunch={launch} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AppCard({ app, disabled, onLaunch }: { app: AppEntry; disabled: boolean; onLaunch: (app: AppEntry) => void }) {
  const chord = chordOf(app);
  return (
    <button
      type="button"
      data-app={app.id}
      disabled={disabled}
      title={disabled ? `${app.name} needs an open tab` : undefined}
      onClick={() => onLaunch(app)}
      className="group flex items-start gap-3 rounded-xl border border-transparent p-3 text-left transition-colors hover:border-line-2 hover:bg-surface-2 focus-visible:border-accent focus-visible:outline-none disabled:opacity-45"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2 transition-colors group-hover:bg-surface-3 group-hover:text-ink">
        {app.id === "agent" ? <AgentIcon size={18} className="text-highlight" /> : <Icon icon={app.icon} size={18} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-medium text-ink">{app.name}</span>
          {chord && <kbd className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-3">{chord}</kbd>}
        </span>
        <span className="line-clamp-2 text-[11px] leading-snug text-ink-3">{app.blurb}</span>
      </span>
    </button>
  );
}
