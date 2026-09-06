import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Vitest runs in Node; the browser-only tsconfig intentionally omits Node types.
import { readFileSync } from "node:fs";
import { ipc } from "../lib/ipc";
import { useBrowser } from "./browser";
import { DEFAULT_APPEARANCE, DEFAULT_PREFS, accentInk, applyAppearance, isDefaultAppearance, resolveMotion, usePrefs, watchReducedMotion } from "./prefs";

const styles = readFileSync("src/styles.css", "utf8");

afterEach(() => {
  for (const name of ["data-theme", "data-density", "data-tab-style", "data-motion", "style"]) document.documentElement.removeAttribute(name);
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: false });
  useBrowser.setState({ error: null });
  vi.restoreAllMocks();
});

describe("preference persistence", () => {
  it("does not replay a rejected activation through a later unrelated preference write", async () => {
    let rejectActivation!: (error: Error) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const write = vi.spyOn(ipc, "prefsSet").mockImplementationOnce(() => {
      started();
      return new Promise((_, reject) => { rejectActivation = reject; });
    }).mockImplementation(async (prefs) => prefs);
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
    const activation = usePrefs.getState().update({ agent_provider: "openai", agent_model: "fixture-model" }, { rejectOnError: true });
    const rejected = expect(activation).rejects.toThrow("save failed");
    await firstStarted;
    const unrelated = usePrefs.getState().update({ do_not_track: true });
    rejectActivation(Error("save failed"));
    await rejected;
    await unrelated;
    expect(write.mock.calls[1]?.[0]).toMatchObject({ agent_provider: DEFAULT_PREFS.agent_provider, agent_model: DEFAULT_PREFS.agent_model, do_not_track: true });
    expect(usePrefs.getState().prefs).toMatchObject({ agent_provider: DEFAULT_PREFS.agent_provider, agent_model: DEFAULT_PREFS.agent_model, do_not_track: true });
  });

  it("lets transactional callers observe a failed save without poisoning later writes", async () => {
    vi.spyOn(ipc, "prefsSet").mockRejectedValueOnce(Error("disk full")).mockImplementation(async (prefs) => prefs);
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
    await expect(usePrefs.getState().update({ agent_provider: "openai" }, { rejectOnError: true })).rejects.toThrow("disk full");
    expect(usePrefs.getState().prefs.agent_provider).toBe(DEFAULT_PREFS.agent_provider);
    await usePrefs.getState().update({ agent_provider: "ollama" }, { rejectOnError: true });
    expect(usePrefs.getState().prefs.agent_provider).toBe("ollama");
  });

  it("serializes full snapshots so an older host apply finishes first", async () => {
    let finishFirst!: (prefs: typeof DEFAULT_PREFS) => void;
    let finishSecond!: (prefs: typeof DEFAULT_PREFS) => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondCall = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const write = vi.spyOn(ipc, "prefsSet")
      .mockImplementationOnce(() => {
        firstStarted();
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      })
      .mockImplementationOnce(() => {
        secondStarted();
        return new Promise((resolve) => {
          finishSecond = resolve;
        });
      });
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });

    const first = usePrefs.getState().update({ block_trackers: true });
    await firstCall;
    const second = usePrefs.getState().update({ do_not_track: true });
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);

    finishFirst({ ...DEFAULT_PREFS, block_trackers: true });
    await first;
    await secondCall;
    finishSecond({ ...DEFAULT_PREFS, block_trackers: true, do_not_track: true });
    await second;

    expect(usePrefs.getState().prefs.block_trackers).toBe(true);
    expect(usePrefs.getState().prefs.do_not_track).toBe(true);
  });

  it("does not let an older load replace a newer stored update", async () => {
    let finishLoad!: (prefs: typeof DEFAULT_PREFS) => void;
    vi.spyOn(ipc, "prefsGet").mockImplementation(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    vi.spyOn(ipc, "prefsSet").mockImplementation((prefs) => Promise.resolve(prefs));
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: false });

    const loading = usePrefs.getState().load();
    await usePrefs.getState().update({ block_trackers: true });
    finishLoad(DEFAULT_PREFS);
    await loading;

    expect(usePrefs.getState().prefs.block_trackers).toBe(true);
  });

  it("keeps stored values and an early write when the load finishes late", async () => {
    let finishLoad!: (prefs: typeof DEFAULT_PREFS) => void;
    vi.spyOn(ipc, "prefsGet").mockImplementation(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    const write = vi.spyOn(ipc, "prefsSet").mockImplementation((prefs) => Promise.resolve(prefs));
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: false });

    const loading = usePrefs.getState().load();
    // The rail is collapsed before the stored preferences have arrived.
    await usePrefs.getState().update({ rail_expanded: false });
    finishLoad({ ...DEFAULT_PREFS, accent: "#123456", block_trackers: true });
    await loading;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const prefs = usePrefs.getState().prefs;
    expect(prefs.rail_expanded).toBe(false);
    expect(prefs.accent).toBe("#123456");
    expect(prefs.block_trackers).toBe(true);
    // The store is repaired: the reconciled snapshot is written back.
    const last = write.mock.calls.at(-1)?.[0];
    expect(last?.rail_expanded).toBe(false);
    expect(last?.accent).toBe("#123456");
  });

  it("rolls an optimistic update back when the host rejects it", async () => {
    vi.spyOn(ipc, "prefsSet").mockRejectedValue(new Error("preferences unavailable"));
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });

    await usePrefs.getState().update({ block_trackers: true });

    expect(usePrefs.getState().prefs.block_trackers).toBe(false);
    expect(useBrowser.getState().error).toBe("preferences unavailable");
  });

  it("does not let a stale failed write undo a newer stored choice", async () => {
    let failFirst!: (error: Error) => void;
    let finishSecond!: (prefs: typeof DEFAULT_PREFS) => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondCall = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    vi.spyOn(ipc, "prefsSet")
      .mockImplementationOnce(() => {
        firstStarted();
        return new Promise((_, reject) => {
          failFirst = reject;
        });
      })
      .mockImplementationOnce(() => {
        secondStarted();
        return new Promise((resolve) => {
          finishSecond = resolve;
        });
      });
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });

    const first = usePrefs.getState().update({ block_trackers: true });
    await firstCall;
    const second = usePrefs.getState().update({ do_not_track: true });
    failFirst(new Error("stale failure"));
    await first;
    await secondCall;
    finishSecond({ ...DEFAULT_PREFS, block_trackers: true, do_not_track: true });
    await second;

    expect(usePrefs.getState().prefs.block_trackers).toBe(true);
    expect(usePrefs.getState().prefs.do_not_track).toBe(true);
  });
});

describe("applyAppearance", () => {
  it("puts an explicit theme on the document root", () => {
    applyAppearance({ ...DEFAULT_PREFS, theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resolves the system theme to a concrete palette", () => {
    applyAppearance({ ...DEFAULT_PREFS, theme: "system" });
    // jsdom answers no to every media query, so this is the dark branch.
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("overrides the highlight only for a chosen accent", () => {
    const root = document.documentElement;
    applyAppearance({ ...DEFAULT_PREFS, accent: "#8FB8F0" });
    expect(root.style.getPropertyValue("--color-highlight")).toBe("#8FB8F0");
    expect(root.style.getPropertyValue("--color-highlight-soft")).toContain("color-mix");
    expect(root.style.getPropertyValue("--color-highlight-ink")).toBe("#111111");

    applyAppearance(DEFAULT_PREFS);
    expect(root.style.getPropertyValue("--color-highlight")).toBe("");
    expect(root.style.getPropertyValue("--color-highlight-ink")).toBe("");
  });

  it("puts density, tab style and motion on the root as data attributes", () => {
    const root = document.documentElement;
    applyAppearance({ ...DEFAULT_PREFS, density: "compact", tab_style: "flat", motion: "reduce" });
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.tabStyle).toBe("flat");
    expect(root.dataset.motion).toBe("reduce");
    applyAppearance(DEFAULT_PREFS);
    expect(root.dataset.density).toBe("comfortable");
    expect(root.dataset.tabStyle).toBe("pill");
    // jsdom answers no to every media query, so following the system is full motion.
    expect(root.dataset.motion).toBe("full");
  });

  it("resolves motion from the preference, then the OS", () => {
    expect(resolveMotion({ ...DEFAULT_PREFS, motion: "reduce" })).toBe("reduce");
    expect(resolveMotion({ ...DEFAULT_PREFS, motion: "full" })).toBe("full");
    const query = { matches: true, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(query);
    expect(resolveMotion({ ...DEFAULT_PREFS, motion: "system" })).toBe("reduce");
    expect(resolveMotion({ ...DEFAULT_PREFS, motion: "full" })).toBe("full");
  });

  it("unconditionally suppresses privacy motion when the OS requests reduced motion", () => {
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?\.privacy-motion\s*\{[^}]*animation: none !important;[^}]*transition: none !important;/,
    );
  });

  it("sets every theme variable for a non-default appearance and clears them at the defaults", () => {
    const root = document.documentElement;
    applyAppearance({ ...DEFAULT_PREFS, appearance_preset: "sepia", corner_radius: "sharp", density: "relaxed", ui_font: "serif" });
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("--color-ground")).toBe("#231a14");
    expect(root.style.getPropertyValue("--color-surface")).toContain("color-mix(in oklab");
    expect(root.style.getPropertyValue("--radius-lg")).toBe("3px");
    expect(root.style.getPropertyValue("--row-h")).toBe("40px");
    expect(root.style.getPropertyValue("--font-sans")).toContain("Georgia");

    applyAppearance(DEFAULT_PREFS);
    expect(root.style.getPropertyValue("--color-ground")).toBe("");
    expect(root.style.getPropertyValue("--radius-lg")).toBe("");
    expect(root.style.getPropertyValue("--row-h")).toBe("");
    expect(root.style.getPropertyValue("--font-sans")).toBe("");
  });

  it("lets a fixed template force its scheme over the theme", () => {
    applyAppearance({ ...DEFAULT_PREFS, theme: "light", appearance_preset: "midnight" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyAppearance({ ...DEFAULT_PREFS, theme: "dark", appearance_preset: "paper" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("scales the root font size with the interface size, clamped", () => {
    const root = document.documentElement;
    applyAppearance({ ...DEFAULT_PREFS, ui_scale: 1.2 });
    expect(root.style.fontSize).toBe("19.2px");
    applyAppearance({ ...DEFAULT_PREFS, ui_scale: 3 });
    expect(root.style.fontSize).toBe("20.8px");
    applyAppearance(DEFAULT_PREFS);
    expect(root.style.fontSize).toBe("");
  });

  it("knows when nothing but the accent's case differs from the defaults", () => {
    expect(isDefaultAppearance(DEFAULT_PREFS)).toBe(true);
    expect(isDefaultAppearance({ ...DEFAULT_PREFS, accent: "#7fd8c8" })).toBe(true);
    expect(isDefaultAppearance({ ...DEFAULT_PREFS, tab_style: "flat" })).toBe(false);
    expect(Object.keys(DEFAULT_APPEARANCE)).toContain("welcome_background");
    expect(Object.keys(DEFAULT_APPEARANCE)).not.toContain("homepage");
  });

  it("re-applies motion when the OS setting changes while following it", () => {
    let fire: (() => void) | undefined;
    const query = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => {
        fire = cb;
      },
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    const spy = vi.spyOn(window, "matchMedia").mockReturnValue(query);
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
    const stop = watchReducedMotion();
    expect(spy).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    (query as { matches: boolean }).matches = true;
    fire!();
    expect(document.documentElement.dataset.motion).toBe("reduce");
    stop();
    expect(query.removeEventListener).toHaveBeenCalled();
  });

  it("chooses a readable foreground for pale and dark custom accents", () => {
    expect(accentInk("#E9E9E9")).toBe("#111111");
    expect(accentInk("#28534D")).toBe("#FFFFFF");
  });
});
