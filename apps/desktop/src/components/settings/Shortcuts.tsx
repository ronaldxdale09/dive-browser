import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { Command } from "../../lib/ipc";
import { formatChord } from "../../lib/commands";
import { Group } from "../SettingsFields";

/** Settings › Shortcuts: every bound command, plus the chords the chrome owns. */
export function Shortcuts() {
  const [cmds, setCmds] = useState<Command[]>([]);
  useEffect(() => {
    let alive = true;
    void ipc.commandsList().then((list) => alive && setCmds(list)).catch(() => alive && setCmds([]));
    return () => {
      alive = false;
    };
  }, []);
  const bound = cmds.filter((c) => c.keybinding);
  return (
    <Group title="Keyboard" description="Every command is also in the palette (⌘K), which searches tabs, history, bookmarks and local servers.">
      {bound.map((c) => (
        <div key={c.id} className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{c.title}</span>
          <kbd className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{chord(c.keybinding ?? "")}</kbd>
        </div>
      ))}
      {bound.length === 0 && <p className="py-3 text-xs text-ink-3">No commands registered.</p>}
      {/* Chords the chrome owns outright: they never reach the host, so the
          command registry does not know about them. */}
      {CHROME_CHORDS.map((c) => (
        <div key={c.title} className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{c.title}</span>
          <kbd className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{c.keys}</kbd>
        </div>
      ))}
    </Group>
  );
}

const CHROME_CHORDS = [
  { title: "Switch to workspace 1–9", keys: "⌘1 … ⌘9" },
  { title: "New workspace", keys: "⌘⇧N" },
  { title: "Edit current workspace", keys: "⌘⇧E" },
];

/** "mod+shift+s" as the glyphs the menus show. */
const chord = (k: string) => formatChord(k);
