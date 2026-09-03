import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Prefs as WirePrefs } from "../lib/ipc";
import { useBrowser } from "./browser";

/**
 * User preferences. The host owns them (it clamps and persists), so writes go
 * out immediately and the reply replaces the local copy: a value the host
 * corrected shows the corrected form rather than what was typed.
 *
 * Every key is optional on the wire, because the host fills in defaults for a
 * blob written by an older build. The chrome works with the complete form so
 * no control has to render an undefined value.
 */
export type Prefs = { [K in keyof WirePrefs]-?: NonNullable<WirePrefs[K]> };
export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  accent: "#7FD8C8",
  tell_pages_theme: false,
  startup: "restore",
  homepage: "",
  search_engine: "duckduckgo",
  search_template: "",
  default_zoom: 1,
  do_not_track: false,
  block_trackers: false,
  blocked_patterns: [],
  javascript: true,
  history_days: 0,
  download_dir: "",
  devtools_on_open: false,
  rail_expanded: true,
  agent_model: "claude-opus-5",
  agent_auto_approve: false,
};

interface PrefsState {
  prefs: Prefs;
  loaded: boolean;
  load: () => Promise<void>;
  /** Merge `patch` into the preferences and persist the result. */
  update: (patch: Partial<Prefs>) => Promise<void>;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: DEFAULT_PREFS,
  loaded: false,
  load: async () => {
    try {
      const prefs = complete(await ipc.prefsGet());
      set({ prefs, loaded: true });
      applyAppearance(prefs);
    } catch (e) {
      set({ loaded: true });
      report(e);
    }
  },
  update: async (patch) => {
    const next = { ...get().prefs, ...patch };
    set({ prefs: next });
    applyAppearance(next);
    try {
      const stored = complete(await ipc.prefsSet(next));
      set({ prefs: stored });
      applyAppearance(stored);
    } catch (e) {
      report(e);
    }
  },
}));

/** Fill in anything the host left out, so the UI never binds to undefined. */
function complete(wire: WirePrefs): Prefs {
  const prefs: Record<string, unknown> = { ...DEFAULT_PREFS };
  for (const [key, value] of Object.entries(wire)) {
    if (value !== null && value !== undefined) prefs[key] = value;
  }
  return prefs as Prefs;
}

function report(e: unknown) {
  useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
}

/** The scheme the OS asks for, used when the theme follows the system. */
export function systemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Put theme and accent on the document root. `data-theme` selects the palette
 * in styles.css; a chosen accent overrides the two highlight tokens, and the
 * soft one is mixed from it so a custom accent keeps its quiet companion.
 *
 * The default accent is left to the stylesheet on purpose: each palette tunes
 * its own highlight, and the dark one's mint is too pale on a light ground.
 */
export function applyAppearance(prefs: Prefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme === "system" ? systemTheme() : prefs.theme;
  if (prefs.accent.toUpperCase() === DEFAULT_PREFS.accent.toUpperCase()) {
    root.style.removeProperty("--color-highlight");
    root.style.removeProperty("--color-highlight-soft");
    return;
  }
  root.style.setProperty("--color-highlight", prefs.accent);
  root.style.setProperty("--color-highlight-soft", `color-mix(in oklab, ${prefs.accent} 22%, var(--color-ground))`);
}

/** Re-apply the palette when the OS scheme changes while following it. */
export function watchSystemTheme(): () => void {
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    const { prefs } = usePrefs.getState();
    if (prefs.theme === "system") applyAppearance(prefs);
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
