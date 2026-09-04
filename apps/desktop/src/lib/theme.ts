/**
 * The chrome's theme engine. A template is three seed colours (ground, ink,
 * highlight) per scheme; everything else the stylesheet needs is mixed from
 * them with `color-mix(in oklab, …)` so a new template is a handful of hex
 * values rather than a second stylesheet. Graphite, the default, keeps the
 * stylesheet's hand-tuned literals so nothing moves for a user who never
 * opens Appearance.
 */
import type { Prefs } from "../store/prefs";

export type Scheme = "dark" | "light";
export type Seeds = { ground: string; ink: string; highlight: string };

export type Preset = {
  id: string;
  name: string;
  description: string;
  /** `auto` follows the theme preference; the others force one palette. */
  scheme: Scheme | "auto";
  dark?: Seeds;
  light?: Seeds;
};

export const PRESETS: readonly Preset[] = [
  {
    id: "graphite",
    name: "Graphite",
    description: "Neutral dark with a cool mint highlight; light when the OS asks for it.",
    scheme: "auto",
    dark: { ground: "#111111", ink: "#ececec", highlight: "#7fd8c8" },
    light: { ground: "#f3f3f1", ink: "#161616", highlight: "#0f8f7e" },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Near-black with a cool grey ink and a deeper teal highlight.",
    scheme: "dark",
    dark: { ground: "#0b0c0e", ink: "#e4e8ec", highlight: "#5fd3c4" },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Warm off-white, near-black ink and a muted green. Light only.",
    scheme: "light",
    light: { ground: "#f7f4ec", ink: "#1a1917", highlight: "#4f8a5b" },
  },
  {
    id: "sepia",
    name: "Sepia",
    description: "Dark brown ground, cream ink and an amber highlight.",
    scheme: "dark",
    dark: { ground: "#231a14", ink: "#f0e4d2", highlight: "#e0a04a" },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Green-black ground, pale ink and a leaf-green highlight.",
    scheme: "dark",
    dark: { ground: "#0f1512", ink: "#dfe8e0", highlight: "#7ccf8a" },
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Deep slate-teal ground, pale ink and an aqua highlight.",
    scheme: "dark",
    dark: { ground: "#0f1a1c", ink: "#dde9ea", highlight: "#5fd8dc" },
  },
  {
    id: "rose",
    name: "Rose",
    description: "Dark plum ground, warm ink and a rose highlight.",
    scheme: "dark",
    dark: { ground: "#1c1218", ink: "#f1e3ea", highlight: "#e58aa8" },
  },
];

export const CUSTOM_PRESET_ID = "custom";

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The token names `derivePalette` fills in, in the stylesheet's order. */
export type Palette = {
  ground: string;
  surface: string;
  surface2: string;
  surface3: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  line2: string;
  accent: string;
  accentInk: string;
  highlight: string;
  highlightInk: string;
  highlightSoft: string;
  danger: string;
  dangerInk: string;
};

/**
 * Mix percentages toward the other seed, chosen so Graphite's derived
 * surfaces land on the stylesheet's literals (theme.test.ts checks this).
 * Dark surfaces climb from the ground toward the ink; light surfaces sit
 * between the ground and white, since a card on a light ground is lighter.
 */
export const MIX = {
  dark: { surface: 4, surface2: 8, surface3: 12, line: 12, line2: 19, ink2: 72, ink3: 60, accent: 98, soft: 22 },
  light: { surface2: 3, surface3: 7, line: 7, line2: 14, ink2: 65, ink3: 58, accent: 100, soft: 22 },
} as const;

const DANGER = "#f0715e";

/** Graphite's stylesheet literals, kept exact rather than derived. */
const GRAPHITE: Record<Scheme, Palette> = {
  dark: {
    ground: "#111111",
    surface: "#181818",
    surface2: "#1f1f1f",
    surface3: "#262626",
    ink: "#ececec",
    ink2: "#a8a8a8",
    ink3: "#8c8c8c",
    line: "#262626",
    line2: "#333333",
    accent: "#e9e9e9",
    accentInk: "#111111",
    highlight: "#7fd8c8",
    highlightInk: "#111111",
    highlightSoft: "#163430",
    danger: DANGER,
    dangerInk: "#111111",
  },
  light: {
    ground: "#f3f3f1",
    surface: "#ffffff",
    surface2: "#ececea",
    surface3: "#e2e2df",
    ink: "#161616",
    ink2: "#5b5b5b",
    ink3: "#696969",
    line: "#e1e1de",
    line2: "#cfcfcb",
    accent: "#161616",
    accentInk: "#ffffff",
    highlight: "#0f8f7e",
    highlightInk: "#ffffff",
    highlightSoft: "#d8f1ec",
    danger: DANGER,
    dangerInk: "#111111",
  },
};

function mix(a: string, pct: number, b: string): string {
  return `color-mix(in oklab, ${a} ${pct}%, ${b})`;
}

/** The full token set for a seed triple, as CSS colour expressions. */
export function derivePalette(seeds: Seeds, scheme: Scheme): Palette {
  const { ground, ink, highlight } = seeds;
  const m = MIX[scheme];
  const base = {
    ground,
    ink,
    ink2: mix(ink, m.ink2, ground),
    ink3: mix(ink, m.ink3, ground),
    surface2: mix(ground, 100 - m.surface2, ink),
    surface3: mix(ground, 100 - m.surface3, ink),
    line: mix(ground, 100 - m.line, ink),
    line2: mix(ground, 100 - m.line2, ink),
    accent: m.accent === 100 ? ink : mix(ink, m.accent, ground),
    accentInk: accentInk(ink),
    highlight,
    highlightInk: accentInk(highlight),
    highlightSoft: mix(highlight, m.soft, ground),
    danger: DANGER,
    dangerInk: "#111111",
  };
  const surface = scheme === "dark" ? mix(ground, 100 - MIX.dark.surface, ink) : mix(ground, 20, "#ffffff");
  return { ...base, surface };
}

/** Seeds for a preset in a scheme; a fixed preset answers only its own. */
export function presetSeeds(preset: Preset, scheme: Scheme): Seeds | undefined {
  return scheme === "dark" ? preset.dark : preset.light;
}

/** Which of the two palettes a preference set lands on. */
export function resolveScheme(prefs: Prefs, system: () => Scheme = systemScheme): Scheme {
  const preset = findPreset(prefs.appearance_preset);
  if (preset && preset.scheme !== "auto") return preset.scheme;
  if (!preset && prefs.appearance_preset === CUSTOM_PRESET_ID) {
    // A custom template has one seed set, so its ground decides the scheme;
    // the theme preference would otherwise invert its surfaces.
    return luminance(prefs.custom_ground) < 0.4 ? "dark" : "light";
  }
  if (prefs.theme === "dark" || prefs.theme === "light") return prefs.theme;
  return system();
}

function systemScheme(): Scheme {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The palette a preference set asks for. */
export function resolvePalette(prefs: Prefs, scheme: Scheme = resolveScheme(prefs)): Palette {
  const preset = findPreset(prefs.appearance_preset);
  let palette: Palette;
  if (preset?.id === "graphite") {
    palette = GRAPHITE[scheme];
  } else if (preset) {
    const seeds = presetSeeds(preset, scheme) ?? preset.dark ?? preset.light!;
    palette = derivePalette(seeds, scheme);
  } else {
    palette = derivePalette({ ground: prefs.custom_ground, ink: prefs.custom_ink, highlight: prefs.custom_highlight }, scheme);
  }
  if (prefs.accent.toUpperCase() !== DEFAULT_ACCENT) {
    palette = {
      ...palette,
      highlight: prefs.accent,
      highlightInk: accentInk(prefs.accent),
      highlightSoft: mix(prefs.accent, MIX[scheme].soft, palette.ground),
    };
  }
  return palette;
}

const DEFAULT_ACCENT = "#7FD8C8";

export const FONTS = {
  geist: '"Geist Variable", system-ui, -apple-system, "Segoe UI", sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
  mono: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
} as const;

/** Tailwind's radius scale per corner preference: sm, md, lg, xl, 2xl, 3xl. */
export const RADII = {
  sharp: ["1px", "2px", "3px", "4px", "6px", "8px"],
  soft: ["2px", "3px", "4px", "6px", "8px", "12px"],
  round: ["0.25rem", "0.375rem", "0.5rem", "0.75rem", "1rem", "1.5rem"],
} as const;

export const DENSITY = {
  compact: { row: "30px", gap: "2px" },
  comfortable: { row: "36px", gap: "4px" },
  relaxed: { row: "40px", gap: "6px" },
} as const;

const PALETTE_VARS: Record<keyof Palette, string> = {
  ground: "--color-ground",
  surface: "--color-surface",
  surface2: "--color-surface-2",
  surface3: "--color-surface-3",
  ink: "--color-ink",
  ink2: "--color-ink-2",
  ink3: "--color-ink-3",
  line: "--color-line",
  line2: "--color-line-2",
  accent: "--color-accent",
  accentInk: "--color-accent-ink",
  highlight: "--color-highlight",
  highlightInk: "--color-highlight-ink",
  highlightSoft: "--color-highlight-soft",
  danger: "--color-danger",
  dangerInk: "--color-danger-ink",
};

const RADIUS_VARS = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-2xl", "--radius-3xl"];

/** Every custom property `themeCss` may set, so a reset can clear them all. */
export const THEME_VARS: readonly string[] = [...Object.values(PALETTE_VARS), "--font-sans", ...RADIUS_VARS, "--row-h", "--ui-gap"];

/** The custom properties a preference set puts on the root. */
export function themeCss(prefs: Prefs, scheme: Scheme = resolveScheme(prefs)): [string, string][] {
  const palette = resolvePalette(prefs, scheme);
  const pairs: [string, string][] = (Object.keys(PALETTE_VARS) as (keyof Palette)[]).map((key) => [PALETTE_VARS[key], palette[key]]);
  pairs.push(["--font-sans", FONTS[prefs.ui_font as keyof typeof FONTS] ?? FONTS.geist]);
  const radii = RADII[prefs.corner_radius as keyof typeof RADII] ?? RADII.round;
  RADIUS_VARS.forEach((name, i) => pairs.push([name, radii[i]!]));
  const density = DENSITY[prefs.density as keyof typeof DENSITY] ?? DENSITY.comfortable;
  pairs.push(["--row-h", density.row], ["--ui-gap", density.gap]);
  return pairs;
}

// -- sharing ---------------------------------------------------------------

export const APPEARANCE_KEYS = [
  "theme",
  "accent",
  "appearance_preset",
  "custom_ground",
  "custom_ink",
  "custom_highlight",
  "ui_font",
  "ui_scale",
  "density",
  "corner_radius",
  "tab_style",
  "motion",
  "welcome_background",
] as const;
export type AppearanceKey = (typeof APPEARANCE_KEYS)[number];
export type Appearance = Pick<Prefs, AppearanceKey>;

const ENUMS: Partial<Record<AppearanceKey, readonly string[]>> = {
  theme: ["system", "dark", "light"],
  appearance_preset: [...PRESETS.map((p) => p.id), CUSTOM_PRESET_ID],
  ui_font: Object.keys(FONTS),
  density: Object.keys(DENSITY),
  corner_radius: Object.keys(RADII),
  tab_style: ["pill", "flat"],
  motion: ["system", "reduce", "full"],
  welcome_background: ["orbs", "plain", "gradient"],
};
const HEXES: readonly AppearanceKey[] = ["accent", "custom_ground", "custom_ink", "custom_highlight"];

export function isHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/** Just the appearance fields, as text a user can paste to someone else. */
export function exportTheme(prefs: Prefs): string {
  const out: Record<string, unknown> = {};
  for (const key of APPEARANCE_KEYS) out[key] = prefs[key];
  return JSON.stringify(out, null, 2);
}

/**
 * Parse a shared theme. Unknown keys are ignored, absent keys are left to
 * the current preferences; a bad value throws with the field named.
 */
export function importTheme(json: string): Partial<Appearance> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not a theme: the text is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Not a theme: expected an object.");
  const record = parsed as Record<string, unknown>;
  const out: Partial<Appearance> = {};
  for (const key of APPEARANCE_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (HEXES.includes(key)) {
      if (!isHex(value)) throw new Error(`Not a theme: ${key} must be a hex colour like #7fd8c8.`);
      out[key as "accent"] = value;
    } else if (key === "ui_scale") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0.8 || value > 1.3) throw new Error("Not a theme: ui_scale must be a number from 0.8 to 1.3.");
      out.ui_scale = value;
    } else {
      const allowed = ENUMS[key]!;
      if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`Not a theme: ${key} must be one of ${allowed.join(", ")}.`);
      out[key as "theme"] = value;
    }
  }
  if (Object.keys(out).length === 0) throw new Error("Not a theme: none of the appearance fields are present.");
  return out;
}

// -- colour maths ----------------------------------------------------------

function channels(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  return [0, 2, 4].map((o) => Number.parseInt(full.slice(o, o + 2), 16) / 255) as [number, number, number];
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a hex colour; 0 for anything malformed. */
export function luminance(hex: string): number {
  if (!isHex(hex)) return 0;
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pick the foreground with the stronger WCAG contrast against a hex colour. */
export function accentInk(hex: string): "#111111" | "#FFFFFF" {
  if (!isHex(hex)) return "#111111";
  const l = luminance(hex);
  const darkContrast = (l + 0.05) / 0.0586;
  const lightContrast = 1.05 / (l + 0.05);
  return darkContrast >= lightContrast ? "#111111" : "#FFFFFF";
}

function toOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const gamma = (c: number) => {
    const v = Math.min(1, Math.max(0, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [gamma(lr), gamma(lg), gamma(lb)];
}

/** `color-mix(in oklab, a pct%, b)` computed in JS, as a hex colour. */
export function mixOklab(a: string, pct: number, b: string): string {
  const t = pct / 100;
  const [la, aa, ba] = toOklab(channels(a));
  const [lb, ab, bb] = toOklab(channels(b));
  const rgb = fromOklab([la * t + lb * (1 - t), aa * t + ab * (1 - t), ba * t + bb * (1 - t)]);
  return "#" + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve a palette expression to hex when it is a mix of hex seeds; used
 * by tests and previews that need a concrete colour rather than CSS.
 */
export function toHex(expression: string): string {
  if (isHex(expression)) return expression.toLowerCase();
  const m = /^color-mix\(in oklab, (#[0-9a-f]{6}) (\d+(?:\.\d+)?)%, (#[0-9a-f]{6})\)$/i.exec(expression);
  if (!m) throw new Error(`cannot resolve ${expression}`);
  return mixOklab(m[1]!, Number(m[2]), m[3]!);
}
