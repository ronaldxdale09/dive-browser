import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "./browser";
import { DEFAULT_PREFS, accentInk, applyAppearance, usePrefs } from "./prefs";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: false });
  useBrowser.setState({ error: null });
  vi.restoreAllMocks();
});

describe("preference persistence", () => {
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
    vi.spyOn(ipc, "prefsSet")
      .mockImplementationOnce(() => new Promise((_, reject) => {
        failFirst = reject;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishSecond = resolve;
      }));
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });

    const first = usePrefs.getState().update({ block_trackers: true });
    const second = usePrefs.getState().update({ do_not_track: true });
    finishSecond({ ...DEFAULT_PREFS, block_trackers: true, do_not_track: true });
    await second;
    failFirst(new Error("stale failure"));
    await first;

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

  it("chooses a readable foreground for pale and dark custom accents", () => {
    expect(accentInk("#E9E9E9")).toBe("#111111");
    expect(accentInk("#28534D")).toBe("#FFFFFF");
  });
});
