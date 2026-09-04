import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Prefs as WirePrefs } from "../lib/ipc";
import { useBrowser } from "./browser";
import { APPEARANCE_KEYS, THEME_VARS, accentInk, resolveScheme, themeCss } from "../lib/theme";

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
  startup: "home",
  homepage: "",
  search_engine: "duckduckgo",
  search_template: "",
  default_zoom: 1,
  do_not_track: false,
  block_trackers: false,
  blocked_patterns: [],
  youtube_protection: true,
  privacy_exceptions: [],
  javascript: true,
  history_days: 0,
  download_dir: "",
  devtools_on_open: false,
  rail_expanded: true,
  agent_provider: "anthropic",
  agent_model: "claude-opus-5",
  agent_reasoning: "default",
  agent_max_steps: 25,
  agent_auto_approve: false,
  agent_include_page: true,
  agent_custom_base_url: "",
  preferred_editor: "vscode",
  appearance_preset: "graphite",
  custom_ground: "#111111",
  custom_ink: "#ECECEC",
  custom_highlight: "#7FD8C8",
  ui_font: "geist",
  ui_scale: 1,
  density: "comfortable",
  corner_radius: "round",
  tab_style: "pill",
  motion: "system",
  welcome_background: "orbs",
  video_fill_tab: true,
};

/** The appearance fields at their defaults, for "Reset appearance". */
export const DEFAULT_APPEARANCE: Pick<Prefs, (typeof APPEARANCE_KEYS)[number]> = Object.fromEntries(
  APPEARANCE_KEYS.map((key) => [key, DEFAULT_PREFS[key]]),
) as Pick<Prefs, (typeof APPEARANCE_KEYS)[number]>;

interface PrefsState {
  prefs: Prefs;
  loaded: boolean;
  load: () => Promise<void>;
  /** Merge `patch` into the preferences and persist the result. */
  update: (patch: Partial<Prefs>) => Promise<void>;
}

interface PendingWrite {
  revision: number;
  patch: Partial<Prefs>;
}

let confirmedPrefs = DEFAULT_PREFS;
let pendingWrites: PendingWrite[] = [];
let nextWriteRevision = 0;
let writeTail: Promise<void> = Promise.resolve();

function applyPending(base: Prefs, through = Number.MAX_SAFE_INTEGER): Prefs {
  return pendingWrites
    .filter((write) => write.revision <= through)
    .reduce((prefs, write) => ({ ...prefs, ...write.patch }), base);
}

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: DEFAULT_PREFS,
  loaded: false,
  load: async () => {
    const previous = get().prefs;
    try {
      const prefs = complete(await ipc.prefsGet());
      if (get().prefs === previous) {
        confirmedPrefs = prefs;
        set({ prefs, loaded: true });
        applyAppearance(prefs);
      } else {
        set({ loaded: true });
      }
    } catch (e) {
      set({ loaded: true });
      report(e);
    }
  },
  update: async (patch) => {
    const previous = get().prefs;
    const next = { ...previous, ...patch };
    if (pendingWrites.length === 0) confirmedPrefs = previous;
    const write = { revision: ++nextWriteRevision, patch: { ...patch } };
    pendingWrites.push(write);
    set({ prefs: next });
    applyAppearance(next);
    const persisted = writeTail.then(async () => {
      const snapshot = applyPending(confirmedPrefs, write.revision);
      try {
        const stored = complete(await ipc.prefsSet(snapshot));
        confirmedPrefs = stored;
        pendingWrites = pendingWrites.filter((pending) => pending.revision > write.revision);
        const current = applyPending(confirmedPrefs);
        set({ prefs: current });
        applyAppearance(current);
      } catch (e) {
        const hasLaterWrite = pendingWrites.some((pending) => pending.revision > write.revision);
        if (!hasLaterWrite) {
          pendingWrites = pendingWrites.filter((pending) => pending.revision > write.revision);
          set({ prefs: confirmedPrefs });
          applyAppearance(confirmedPrefs);
        }
        report(e);
      }
    });
    writeTail = persisted.catch(() => undefined);
    await persisted;
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

export { accentInk };

/** Whether the OS asks for reduced motion right now. */
export function systemReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The motion the chrome should show: the preference, or the OS when following it. */
export function resolveMotion(prefs: Prefs): "reduce" | "full" {
  if (prefs.motion === "reduce") return "reduce";
  if (prefs.motion === "full") return "full";
  return systemReducedMotion() ? "reduce" : "full";
}

/** True when no appearance field differs from its default. */
export function isDefaultAppearance(prefs: Prefs): boolean {
  return APPEARANCE_KEYS.every((key) => {
    const value = prefs[key];
    const fallback = DEFAULT_PREFS[key];
    return typeof value === "string" && typeof fallback === "string" ? value.toUpperCase() === fallback.toUpperCase() : value === fallback;
  });
}

/**
 * Put the appearance on the document root. `data-theme` selects the
 * palette in styles.css, the other data attributes switch layout and motion
 * rules, and the theme engine's custom properties override the stylesheet's
 * tokens. At the defaults the inline properties are removed instead, so the
 * stylesheet's own values apply and the root carries nothing extra.
 */
export function applyAppearance(prefs: Prefs) {
  const root = document.documentElement;
  const scheme = resolveScheme(prefs, systemTheme);
  root.dataset.theme = scheme;
  root.dataset.density = prefs.density;
  root.dataset.tabStyle = prefs.tab_style;
  root.dataset.motion = resolveMotion(prefs);
  if (isDefaultAppearance(prefs)) {
    for (const name of THEME_VARS) root.style.removeProperty(name);
    root.style.removeProperty("font-size");
    return;
  }
  for (const [name, value] of themeCss(prefs, scheme)) root.style.setProperty(name, value);
  const scale = Math.min(1.3, Math.max(0.8, prefs.ui_scale || 1));
  if (scale === 1) root.style.removeProperty("font-size");
  else root.style.fontSize = `${16 * scale}px`;
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

/** Re-apply motion when the OS reduce-motion setting changes while following it. */
export function watchReducedMotion(): () => void {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onChange = () => {
    const { prefs } = usePrefs.getState();
    if (prefs.motion === "system") applyAppearance(prefs);
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
