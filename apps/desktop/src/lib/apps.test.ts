import { describe, expect, it } from "vitest";
import { APP_CATEGORIES, MAX_BLURB, appsFor, chordOf, searchApps } from "./apps";

describe("apps", () => {
  it("keeps every blurb short enough that the launcher's clamp does not cut it", () => {
    // The tiles clamp to two lines. A blurb past the ceiling ends mid-word
    // behind an ellipsis, which is what this pins.
    const tooLong = appsFor(false).filter((app) => app.blurb.length > MAX_BLURB);
    expect(tooLong.map((a) => `${a.name}: ${a.blurb.length}`)).toEqual([]);
  });

  it("ends every blurb as a sentence, so a tile never trails off", () => {
    for (const app of appsFor(false)) {
      expect(app.blurb.endsWith("."), `${app.name}: ${app.blurb}`).toBe(true);
      expect(app.blurb).not.toMatch(/…|\.\.\./);
    }
  });

  it("files each app under a real category", () => {
    const known = new Set(APP_CATEGORIES.map((c) => c.id));
    for (const app of appsFor(false)) expect(known.has(app.category)).toBe(true);
  });

  it("hides what a private window has no place for", () => {
    const normal = appsFor(false).map((a) => a.id);
    const priv = appsFor(true).map((a) => a.id);
    expect(priv.length).toBeLessThanOrEqual(normal.length);
    for (const id of priv) expect(normal).toContain(id);
  });

  it("searches names, blurbs and the extra keywords", () => {
    const apps = appsFor(false);
    expect(searchApps(apps, "playwright").map((a) => a.id)).toContain("recorder");
    expect(searchApps(apps, "keychain").map((a) => a.id)).toContain("passwords");
    expect(searchApps(apps, "").length).toBe(apps.length);
    expect(searchApps(apps, "zzzznothing")).toEqual([]);
  });

  it("offers a chord only where one is bound", () => {
    for (const app of appsFor(false)) {
      const chord = chordOf(app);
      if (chord !== undefined) expect(chord.length).toBeGreaterThan(0);
    }
  });
});
