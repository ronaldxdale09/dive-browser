import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { COMMAND_TITLES, SHORTCUTS, formatChord, isMac } from "../lib/commands";
import { ipc } from "../lib/ipc";
import type { Command } from "../lib/ipc";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { IconButton } from "./Icon";

/** One row of the cheatsheet. */
export interface ShortcutRow {
  id: string;
  title: string;
  /** Every chord bound to the command, in the notation Rust reports. */
  chords: string[];
}

export interface ShortcutArea {
  title: string;
  rows: ShortcutRow[];
}

const AREAS: { title: string; match: (id: string) => boolean }[] = [
  { title: "Tabs", match: (id) => id.startsWith("tab.") },
  { title: "Workspaces", match: (id) => id.startsWith("workspace.") },
  { title: "Page", match: (id) => id.startsWith("zoom.") || id.startsWith("find.") || id.startsWith("address.") },
  { title: "Capture and record", match: (id) => id.startsWith("capture.") || id.startsWith("screencast.") || id.startsWith("report.") },
  { title: "Panels and tools", match: () => true },
];

/**
 * Group the shortcut map by area. ⌘1…⌘9 collapse into one row, as the menus
 * do. A title comes from the host's registry when it lists the command, else
 * from the chrome's own list. Pure, so the layout is testable.
 */
export function groupShortcuts(shortcuts: Record<string, string> = SHORTCUTS, known: Command[] = []): ShortcutArea[] {
  const titles = new Map(known.map((c) => [c.id, c.title]));
  const byId = new Map<string, string[]>();
  for (const [chord, id] of Object.entries(shortcuts)) {
    const key = id.startsWith("workspace.jump.") ? "workspace.jump" : id;
    byId.set(key, [...(byId.get(key) ?? []), chord]);
  }
  // Commands the host binds that the chrome's map does not know about.
  for (const c of known) if (c.keybinding && !byId.has(c.id)) byId.set(c.id, [c.keybinding]);
  const rows = [...byId.entries()].map(([id, chords]) => ({
    id,
    title: id === "workspace.jump" ? "Switch to workspace 1–9" : (titles.get(id) ?? COMMAND_TITLES[id] ?? id),
    chords: id === "workspace.jump" ? ["mod+1 … mod+9"] : chords,
  }));
  const areas = AREAS.map((a) => ({ title: a.title, rows: [] as ShortcutRow[] }));
  for (const row of rows) areas[AREAS.findIndex((a) => a.match(row.id))]!.rows.push(row);
  return areas.filter((a) => a.rows.length > 0);
}

/** Every chord Dive answers to, grouped by area: ⌘/. */
export function Shortcuts() {
  useCoversContent(true);
  const toggle = useBrowser((s) => s.toggle);
  const root = useRef<HTMLDivElement>(null);
  const { close, className } = useFadeClose(() => toggle("shortcuts", false));
  useFocusTrap(root, { onEscape: close });
  const [known, setKnown] = useState<Command[]>([]);
  useEffect(() => {
    let alive = true;
    ipc
      .commandsList()
      .then((c) => alive && setKnown(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const mac = isMac();
  const areas = groupShortcuts(SHORTCUTS, known);

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 grid place-items-center ${className}`} onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <header className="flex h-12 shrink-0 items-center border-b border-line px-5">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <span className="flex-1" />
          <IconButton icon={X} label="Close shortcuts" onClick={close} />
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-x-8 gap-y-4 overflow-y-auto px-5 py-4 sm:grid-cols-2">
          {areas.map((area) => (
            <section key={area.title} aria-label={area.title}>
              <h3 className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{area.title}</h3>
              <dl>
                {area.rows.map((r) => (
                  <div key={r.id} className="flex items-center gap-4 border-b border-line py-2 last:border-b-0">
                    <dt className="min-w-0 flex-1 truncate text-xs text-ink">{r.title}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {r.chords.map((c) => (
                        <kbd key={c} className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
                          {c.includes(" … ") ? c.split(" … ").map((part) => formatChord(part, mac)).join(" … ") : formatChord(c, mac)}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="shrink-0 border-t border-line px-5 py-2.5 text-[11px] text-ink-3">Every command is also in the palette ({formatChord("mod+k", mac)}).</footer>
      </div>
    </div>
  );
}
