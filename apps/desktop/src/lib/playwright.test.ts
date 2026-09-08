import { describe, expect, it } from "vitest";
import { playwrightLocator, recordedToSteps, toPlaywrightSpec } from "./playwright";

describe("toPlaywrightSpec", () => {
  it("emits goto, click, fill and press from executed steps", () => {
    const spec = toPlaywrightSpec(
      [
        { id: "1", name: "page_state", input: "{}", action: false },
        { id: "2", name: "page_click", input: '{"ref":"e1"}', action: true, locator: "getByRole('link', { name: 'Go somewhere' })" },
        { id: "3", name: "page_type", input: '{"ref":"e2","text":"dive","submit":true}', action: true, locator: "getByRole('textbox', { name: 'Name' })" },
        { id: "4", name: "page_click", input: '{"ref":"e9"}', action: true, locator: "getByRole('button')", error: true },
      ],
      "https://a.dev/",
      "act test",
    );
    expect(spec).toContain('await page.goto("https://a.dev/");');
    expect(spec).toContain("await page.getByRole('link', { name: 'Go somewhere' }).click();");
    expect(spec).toContain("await page.getByRole('textbox', { name: 'Name' }).fill(\"dive\");");
    expect(spec).toContain("press(\"Enter\")");
    expect(spec).not.toContain("getByRole('button')");
  });
});

describe("recorded steps", () => {
  it("map to agent-shaped steps with locators", () => {
    const steps = recordedToSteps([
      { kind: "navigate", role: "", name: "", value: "https://a.dev/", at: 1 },
      { kind: "click", role: "button", name: "Save", value: "", at: 2 },
      { kind: "type", role: "searchbox", name: "Search", value: "dive", at: 3 },
    ]);
    expect(steps[0]).toMatchObject({ name: "tab_navigate", locator: null });
    expect(steps[1]?.locator).toBe("getByRole('button', { name: 'Save' })");
    expect(steps[2]?.locator).toBe("getByRole('textbox', { name: 'Search' })");
    expect(playwrightLocator("link", "It's")).toBe("getByRole('link', { name: 'It\\'s' })");
    expect(playwrightLocator("link", "a\nb\u2028c")).toBe("getByRole('link', { name: 'abc' })");
    const spec = toPlaywrightSpec(steps, undefined, "recorded");
    expect(spec).toContain("fill(\"dive\")");
  });

  it("does not replay the navigation a click caused as a goto of its own", () => {
    const steps = recordedToSteps([
      { kind: "click", role: "link", name: "Learn more", value: "", at: 1 },
      { kind: "navigate", role: "", name: "", value: "https://www.iana.org/help/example-domains", at: 2 },
      { kind: "navigate", role: "", name: "", value: "https://b.dev/typed", at: 3 },
    ]);
    expect(steps.map((s) => s.name)).toEqual(["page_click", "tab_navigate"]);
    expect(steps[1]?.input).toContain("b.dev/typed");
  });

  it("folds a navigation the engine reported twice, and ends by checking the last address", () => {
    const steps = recordedToSteps([
      { kind: "click", role: "link", name: "HTML", value: "", at: 1 },
      { kind: "navigate", role: "", name: "", value: "https://a.dev/docs/HTML", at: 2 },
      { kind: "navigate", role: "", name: "", value: "https://a.dev/docs/HTML", at: 3 },
      { kind: "navigate", role: "", name: "", value: "https://example.com/", at: 4 },
      { kind: "navigate", role: "", name: "", value: "https://example.com/", at: 5 },
    ]);
    expect(steps.map((s) => s.name)).toEqual(["page_click", "tab_navigate"]);
    const spec = toPlaywrightSpec(steps, "https://a.dev/", "flow");
    expect(spec).not.toContain("docs/HTML");
    expect(spec.split("example.com").length - 1).toBe(2);
    expect(spec).toContain('await expect(page).toHaveURL("https://example.com/");');
    // Nothing known about where it ends: any address will do.
    expect(toPlaywrightSpec([], undefined)).toContain("toHaveURL(/./)");
  });
});
