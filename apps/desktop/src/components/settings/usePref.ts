import { usePrefs } from "../../store/prefs";
import type { Prefs } from "../../store/prefs";

/** Preferences and the writer that persists a change to one of them. */
export function usePref(): [Prefs, (patch: Partial<Prefs>) => void] {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  return [prefs, (patch) => void update(patch)];
}
