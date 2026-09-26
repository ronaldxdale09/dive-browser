import { usePrefs } from "../../store/prefs";
import type { Prefs } from "../../store/prefs";

/**
 * Preferences and the writer that persists a change to one of them. The
 * writer's promise settles once the host has answered (it never rejects;
 * failures are reported), so a field can show what was actually kept.
 */
export function usePref(): [Prefs, (patch: Partial<Prefs>) => Promise<void>] {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  return [prefs, (patch) => update(patch)];
}
