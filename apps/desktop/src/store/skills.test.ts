import { describe, expect, it } from "vitest";
import { DEFAULT_SKILLS, render } from "./skills";

describe("skills", () => {
  it("fills placeholders", () => {
    expect(render("Check {url} titled {title}", { url: "https://a.dev", title: "A" })).toBe("Check https://a.dev titled A");
    expect(render("no placeholders", {})).toBe("no placeholders");
  });
  it("ships defaults with unique ids", () => {
    expect(new Set(DEFAULT_SKILLS.map((s) => s.id)).size).toBe(DEFAULT_SKILLS.length);
  });
});
