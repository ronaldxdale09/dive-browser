import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../store/prefs";
import {
  DENSITY,
  FONTS,
  MIX,
  PRESETS,
  RADII,
  accentInk,
  contrastRatio,
  derivePalette,
  exportTheme,
  importTheme,
  mixOklab,
  resolvePalette,
  resolveScheme,
  themeCss,
  toHex,  contentCornerRadius,
} from "./theme";

/** Per-channel distance between two hex colours, 0 to 255. */
function distance(a: string, b: string): number {
  const ch = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [ch(a), ch(b)];
  return Math.max(...x.map((v, i) => Math.abs(v - y[i]!)));
}

const GRAPHITE_DARK = { surface: "#181818", surface2: "#1f1f1f", surface3: "#262626", line: "#262626", line2: "#333333", ink2: "#a8a8a8", ink3: "#8c8c8c", accent: "#e9e9e9" };
const GRAPHITE_LIGHT = { surface2: "#ececea", surface3: "#e2e2df", line: "#e1e1de", line2: "#cfcfcb", ink2: "#5b5b5b", ink3: "#696969", accent: "#161616" };

describe("derivePalette", () => {
  it("mixes Graphite's dark surfaces to within a few steps of the stylesheet literals", () => {
    const palette = derivePalette({ ground: "#111111", ink: "#ececec", highlight: "#7fd8c8" }, "dark");
    for (const [key, expected] of Object.entries(GRAPHITE_DARK)) {
      const actual = toHex(palette[key as keyof typeof GRAPHITE_DARK]);
      expect(distance(actual, expected), `${key}: ${actual} vs ${expected}`).toBeLessThanOrEqual(4);
    }
    expect(palette.highlight).toBe("#7fd8c8");
    expect(palette.highlightInk).toBe("#111111");
    expect(palette.accentInk).toBe("#111111");
    // The stylesheet's soft highlight is hand-saturated; an oklab mix lands
    // greyer, which is why Graphite keeps its literal (see resolvePalette).
    expect(distance(toHex(palette.highlightSoft), "#163430")).toBeLessThanOrEqual(24);
  });

  it("mixes Graphite's light surfaces to within a few steps of the stylesheet literals", () => {
    const palette = derivePalette({ ground: "#f3f3f1", ink: "#161616", highlight: "#0f8f7e" }, "light");
    for (const [key, expected] of Object.entries(GRAPHITE_LIGHT)) {
      const actual = toHex(palette[key as keyof typeof GRAPHITE_LIGHT]);
      expect(distance(actual, expected), `${key}: ${actual} vs ${expected}`).toBeLessThanOrEqual(4);
    }
    expect(distance(toHex(palette.surface), "#ffffff")).toBeLessThanOrEqual(6);
    expect(palette.accentInk).toBe("#FFFFFF");
    expect(palette.highlightInk).toBe(accentInk("#0f8f7e"));
  });

  it("writes every non-seed token as an oklab mix of the seeds", () => {
    const palette = derivePalette({ ground: "#231a14", ink: "#f0e4d2", highlight: "#e0a04a" }, "dark");
    expect(palette.surface2).toBe(`color-mix(in oklab, #231a14 ${100 - MIX.dark.surface2}%, #f0e4d2)`);
    expect(palette.ink3).toBe(`color-mix(in oklab, #f0e4d2 ${MIX.dark.ink3}%, #231a14)`);
    expect(palette.highlightSoft).toBe(`color-mix(in oklab, #e0a04a ${MIX.dark.soft}%, #231a14)`);
  });

  it("keeps every preset's ink legible on its ground", () => {
    for (const preset of PRESETS) {
      for (const seeds of [preset.dark, preset.light]) {
        if (!seeds) continue;
        expect(contrastRatio(seeds.ink, seeds.ground), preset.id).toBeGreaterThan(10);
      }
    }
  });
});

describe("resolvePalette", () => {
  it("returns the stylesheet's exact literals for Graphite", () => {
    const dark = resolvePalette(DEFAULT_PREFS, "dark");
    expect(dark.surface).toBe("#181818");
    expect(dark.highlightSoft).toBe("#163430");
    const light = resolvePalette(DEFAULT_PREFS, "light");
    expect(light.surface).toBe("#ffffff");
    expect(light.highlight).toBe("#0f8f7e");
  });

  it("lets a chosen accent replace the template's highlight", () => {
    const palette = resolvePalette({ ...DEFAULT_PREFS, accent: "#8FB8F0" }, "dark");
    expect(palette.highlight).toBe("#8FB8F0");
    expect(palette.highlightInk).toBe("#111111");
    expect(palette.highlightSoft).toContain("#8FB8F0 22%");
  });

  it("derives a custom template from its seeds", () => {
    const palette = resolvePalette({ ...DEFAULT_PREFS, appearance_preset: "custom", custom_ground: "#202020", custom_ink: "#F0F0F0", custom_highlight: "#FFAA00" }, "dark");
    expect(palette.ground).toBe("#202020");
    expect(palette.highlight).toBe("#FFAA00");
    expect(palette.surface).toContain("#202020");
  });
});

describe("resolveScheme", () => {
  const system = () => "light" as const;
  it("follows the theme for an auto template", () => {
    expect(resolveScheme({ ...DEFAULT_PREFS, theme: "dark" }, system)).toBe("dark");
    expect(resolveScheme({ ...DEFAULT_PREFS, theme: "light" }, system)).toBe("light");
    expect(resolveScheme({ ...DEFAULT_PREFS, theme: "system" }, system)).toBe("light");
  });
  it("lets a fixed template win over the theme", () => {
    expect(resolveScheme({ ...DEFAULT_PREFS, theme: "light", appearance_preset: "midnight" }, system)).toBe("dark");
    expect(resolveScheme({ ...DEFAULT_PREFS, theme: "dark", appearance_preset: "paper" }, system)).toBe("light");
  });
  it("reads a custom template's scheme off its ground", () => {
    expect(resolveScheme({ ...DEFAULT_PREFS, theme: "light", appearance_preset: "custom", custom_ground: "#101010" }, system)).toBe("dark");
    expect(resolveScheme({ ...DEFAULT_PREFS, theme: "dark", appearance_preset: "custom", custom_ground: "#FAFAF5" }, system)).toBe("light");
  });
});

describe("themeCss", () => {
  it("maps corner radius to the six Tailwind radius tokens", () => {
    const pick = (corner_radius: string) => Object.fromEntries(themeCss({ ...DEFAULT_PREFS, corner_radius }, "dark"));
    expect(pick("sharp")["--radius-lg"]).toBe(RADII.sharp[2]);
    expect(pick("soft")["--radius-2xl"]).toBe("8px");
    expect(pick("round")["--radius-sm"]).toBe("0.25rem");
    expect(pick("round")["--radius-3xl"]).toBe("1.5rem");
  });

  it("maps density to the row height and gap", () => {
    const pick = (density: string) => Object.fromEntries(themeCss({ ...DEFAULT_PREFS, density }, "dark"));
    expect(pick("compact")["--row-h"]).toBe("30px");
    expect(pick("compact")["--ui-gap"]).toBe("2px");
    expect(pick("comfortable")["--row-h"]).toBe(DENSITY.comfortable.row);
    expect(pick("relaxed")["--row-h"]).toBe("40px");
    expect(pick("relaxed")["--ui-gap"]).toBe("6px");
  });

  it("maps the font preference to a stack", () => {
    const pick = (ui_font: string) => Object.fromEntries(themeCss({ ...DEFAULT_PREFS, ui_font }, "dark"))["--font-sans"];
    expect(pick("geist")).toContain("Geist Variable");
    expect(pick("system")).toMatch(/^system-ui/);
    expect(pick("mono")).toContain("Geist Mono Variable");
    expect(pick("serif")).toContain("Georgia");
    expect(pick("nonsense")).toBe(FONTS.geist);
  });
});

describe("sharing", () => {
  it("round-trips the appearance fields and nothing else", () => {
    const prefs = { ...DEFAULT_PREFS, appearance_preset: "sepia", ui_scale: 1.1, density: "compact", accent: "#F0B35E", homepage: "https://x" };
    const json = exportTheme(prefs);
    expect(json).not.toContain("homepage");
    const back = importTheme(json);
    expect(back).toEqual({
      theme: "system",
      accent: "#F0B35E",
      appearance_preset: "sepia",
      custom_ground: "#111111",
      custom_ink: "#ECECEC",
      custom_highlight: "#7FD8C8",
      ui_font: "geist",
      ui_scale: 1.1,
      density: "compact",
      corner_radius: "round",
      tab_style: "pill",
      motion: "system",
      welcome_background: "orbs",
    });
  });

  it("rejects bad hex, bad enums, bad scale and non-JSON", () => {
    expect(() => importTheme('{"accent":"teal"}')).toThrow(/accent/);
    expect(() => importTheme('{"custom_ground":"#12"}')).toThrow(/custom_ground/);
    expect(() => importTheme('{"density":"tight"}')).toThrow(/density/);
    expect(() => importTheme('{"appearance_preset":"navy"}')).toThrow(/appearance_preset/);
    expect(() => importTheme('{"ui_scale":2}')).toThrow(/ui_scale/);
    expect(() => importTheme("not json")).toThrow(/JSON/);
    expect(() => importTheme("[1]")).toThrow(/object/);
    expect(() => importTheme('{"homepage":"x"}')).toThrow(/none/);
  });

  it("accepts a partial theme and ignores unknown keys", () => {
    expect(importTheme('{"tab_style":"flat","extra":1}')).toEqual({ tab_style: "flat" });
  });
});

describe("colour maths", () => {
  it("mixes greys in oklab", () => {
    expect(mixOklab("#000000", 100, "#ffffff")).toBe("#000000");
    expect(mixOklab("#000000", 0, "#ffffff")).toBe("#ffffff");
    expect(distance(mixOklab("#000000", 50, "#ffffff"), "#636363")).toBeLessThanOrEqual(6);
  });
  it("picks a readable foreground", () => {
    expect(accentInk("#E9E9E9")).toBe("#111111");
    expect(accentInk("#28534D")).toBe("#FFFFFF");
    expect(accentInk("nope")).toBe("#111111");
  });
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ececec", "#111111")).toBeGreaterThan(14);
  });
});

describe("contentCornerRadius", () => {
  it("follows the corner preference and is square for sharp", () => {
    expect(contentCornerRadius("sharp")).toBe(0);
    expect(contentCornerRadius("soft")).toBe(4);
    expect(contentCornerRadius("round")).toBe(6);
    expect(contentCornerRadius("anything-else")).toBe(6);
  });
});
