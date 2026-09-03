import { useEffect } from "react";
import { SHORTCUTS, chordOf, runCommand } from "./commands";

/** Global key chords, routed through the shared command dispatcher. */
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
}
