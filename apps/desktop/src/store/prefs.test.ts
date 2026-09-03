import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, applyAppearance } from "./prefs";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
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

    applyAppearance(DEFAULT_PREFS);
    expect(root.style.getPropertyValue("--color-highlight")).toBe("");
  });
});
