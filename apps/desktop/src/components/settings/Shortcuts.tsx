import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { Command } from "../../lib/ipc";
import { COMMAND_TITLES, SHORTCUTS, chordsByCommand, formatChord } from "../../lib/commands";
import { Group } from "../SettingsFields";
import { errorMessage } from "../../lib/errors";

/** Settings › Shortcuts: every bound command, plus the chords the chrome owns. */
export function Shortcuts() {
  // null until the host answers: an empty list at first flashed "No
  // commands registered." on every visit, and a failed read said the same.
  const [cmds, setCmds] = useState<Command[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    void ipc
      .commandsList()
      .then((list) => alive && (setCmds(list), setFailure(null)))
      .catch((e: unknown) => alive && setFailure(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [attempt]);
  const bound = (cmds ?? []).filter((c) => c.keybinding);
  const chrome = chromeChords(cmds ?? []);
  const palette = formatChord(chordsByCommand()["palette.open"] ?? "mod+k");
  return (
    <Group title="Keyboard" description={`The palette (${palette}) searches tabs, history, bookmarks, local servers and commands that apply here.`}>
      {bound.map((c) => (
        <div key={c.id} className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{c.title}</span>
          <kbd className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{chord(c.keybinding ?? "")}</kbd>
        </div>
      ))}
      {cmds === null && failure && (
        <p role="alert" className="flex flex-wrap items-center gap-2 py-3 text-xs text-danger">
          Could not read the host's commands: {failure}
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="h-6 rounded-md border border-line-2 px-2 text-ink hover:bg-surface-2">
            Retry
          </button>
        </p>
      )}
      {cmds === null && !failure && <p role="status" className="py-3 text-xs text-ink-3">Loading…</p>}
      {cmds !== null && bound.length === 0 && <p className="py-3 text-xs text-ink-3">No commands registered.</p>}
      {/* Chords the chrome owns outright: they never reach the host, so the
          command registry does not know about them. */}
      {chrome.map((c) => (
        <div key={c.title} className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{c.title}</span>
          <kbd className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{c.keys}</kbd>
        </div>
      ))}
    </Group>
  );
}

/**
 * Rows for the chords the chrome owns and the host does not list, titled from
 * the chrome's own names. ⌘1…⌘9 collapse into one row, as the menus do.
 */
export function chromeChords(known: Command[], shortcuts: Record<string, string> = SHORTCUTS): { title: string; keys: string }[] {
  const seen = new Set(known.filter((c) => c.keybinding).map((c) => c.id));
  const rows = Object.entries(chordsByCommand(shortcuts))
    .filter(([id]) => !seen.has(id) && !id.startsWith("workspace.jump.") && id in COMMAND_TITLES)
    .map(([id, chord]) => ({ title: COMMAND_TITLES[id]!, keys: formatChord(chord) }));
  if (Object.keys(shortcuts).some((chord) => shortcuts[chord]?.startsWith("workspace.jump."))) {
    rows.push({ title: "Switch to workspace 1–9", keys: `${formatChord("mod+1")} … ${formatChord("mod+9")}` });
  }
  return rows;
}

/** "mod+shift+s" as the glyphs the menus show. */
const chord = (k: string) => formatChord(k);
