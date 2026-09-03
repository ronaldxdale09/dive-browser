import { useEffect } from "react";
import { events } from "./ipc";
import { SHORTCUTS, chordOf, runCommand } from "./commands";

/**
 * Global key chords, routed through the shared command dispatcher.
 *
 * Two sources feed it. The DOM listener catches chords while the chrome has
 * focus; the native menu catches them while the page does, since a focused
 * page webview never lets a key reach this document.
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord = chordOf(e);
      const id = chord && SHORTCUTS[chord];
      if (!id) return;
      e.preventDefault();
      runCommand(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void events.menuCommand.listen((e) => runCommand(e.payload)).then((un) => {
      if (live) stop = un;
      else un();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
}
