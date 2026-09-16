import { describe, expect, it } from "vitest";
import { playwrightLocator, recordedToSteps, replayableSteps, toPlaywrightLocator, toPlaywrightSpec } from "./playwright";

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

describe("toPlaywrightLocator", () => {
  it("translates Dive's grammar into Playwright calls", () => {
    expect(toPlaywrightLocator('role=button[name="Save"]')).toBe("getByRole('button', { name: 'Save' })");
    expect(toPlaywrightLocator('role=heading[name="Title"][level=2][exact]')).toBe("getByRole('heading', { name: 'Title', exact: true, level: 2 })");
    expect(toPlaywrightLocator("role=checkbox[checked]")).toBe("getByRole('checkbox', { checked: true })");
    expect(toPlaywrightLocator("text=Continue")).toBe("getByText('Continue')");
    expect(toPlaywrightLocator('text="Continue"')).toBe("getByText('Continue', { exact: true })");
    expect(toPlaywrightLocator("testid=submit")).toBe("getByTestId('submit')");
    expect(toPlaywrightLocator("label=Email")).toBe("getByLabel('Email')");
    expect(toPlaywrightLocator("placeholder=Search")).toBe("getByPlaceholder('Search')");
    expect(toPlaywrightLocator("alt=Logo")).toBe("getByAltText('Logo')");
    expect(toPlaywrightLocator("title=Close")).toBe("getByTitle('Close')");
  });

  it("treats a bare selector as CSS and chains >> steps", () => {
    expect(toPlaywrightLocator(".btn > span")).toBe("locator('.btn > span')");
    expect(toPlaywrightLocator("css=.btn")).toBe("locator('.btn')");
    expect(toPlaywrightLocator("role=dialog >> text=Delete")).toBe("getByRole('dialog').getByText('Delete')");
  });

  it("applies nth and visible to the step before them", () => {
    expect(toPlaywrightLocator("role=listitem >> nth=2")).toBe("getByRole('listitem').nth(2)");
    expect(toPlaywrightLocator("role=listitem >> nth=-1")).toBe("getByRole('listitem').last()");
    expect(toPlaywrightLocator("role=link >> visible=true")).toBe("getByRole('link').filter({ visible: true })");
    // A modifier with nothing to modify would not compile, so nothing is written.
    expect(toPlaywrightLocator("nth=0")).toBeNull();
    expect(toPlaywrightLocator("   ")).toBeNull();
  });
});

describe("exporting a run", () => {
  const step = (name: string, input: unknown, locator?: string) => ({ id: name, name, input: JSON.stringify(input), action: true, summary: "ok", ...(locator ? { locator } : {}) });

  it("writes every kind of action the agent can take", () => {
    const spec = toPlaywrightSpec(
      [
        step("page_fill_form", { fields: [{ locator: "label=Email", value: "a@b.c" }, { locator: "label=Name", value: "Dev" }], submit: true }),
        step("page_select", { locator: "label=Country", label: "Norway" }),
        step("page_hover", { locator: 'role=button[name="More"]' }),
        step("page_press", { key: "Enter", modifiers: ["Meta"] }),
        step("page_upload", { locator: "css=#file", paths: ["/tmp/a.png"] }),
        step("page_drag", { from: "testid=card", to: "testid=done" }),
        step("page_scroll", { delta_y: 400 }),
        step("page_resize", { width: 390, height: 844 }),
        step("page_wait_for", { text: "Saved" }),
        step("page_wait_for", { url_includes: "/done" }),
      ],
      "https://a.dev/",
      "everything",
    );
    expect(spec).toContain("await page.getByLabel('Email').fill(\"a@b.c\");");
    expect(spec).toContain("await page.getByLabel('Name').press(\"Enter\");");
    expect(spec).toContain("await page.getByLabel('Country').selectOption({ label: \"Norway\" });");
    expect(spec).toContain("await page.getByRole('button', { name: 'More' }).hover();");
    expect(spec).toContain('await page.keyboard.press("Meta+Enter");');
    expect(spec).toContain("await page.locator('#file').setInputFiles(\"/tmp/a.png\");");
    expect(spec).toContain("await page.getByTestId('card').dragTo(page.getByTestId('done'));");
    expect(spec).toContain("await page.mouse.wheel(0, 400);");
    expect(spec).toContain("await page.setViewportSize({ width: 390, height: 844 });");
    // A wait is the agent saying what had to be true: that is the assertion.
    expect(spec).toContain("await expect(page.getByText('Saved')).toBeVisible();");
    expect(spec).toContain('await page.waitForURL("**/done**");');
    expect(spec).not.toContain("waitForTimeout");
  });

  it("leaves out reads, failures and anything it cannot address", () => {
    const steps = [
      { id: "1", name: "page_text", input: "{}", action: false, summary: "…" },
      { id: "2", name: "page_click", input: '{"x":10,"y":20}', action: true, summary: "ok" },
      { id: "3", name: "page_click", input: '{"locator":"text=Nope"}', action: true, error: true, summary: "no match" },
      { id: "4", name: "page_click", input: '{"locator":"text=Yes"}', action: true, summary: "ok" },
    ];
    const spec = toPlaywrightSpec(steps, "https://a.dev/");
    expect(spec).toContain("getByText('Yes').click()");
    expect(spec).not.toContain("Nope");
    expect(spec).not.toContain("page_text");
    // A click with only coordinates has nothing a test could address.
    expect(spec.split("click(").length - 1).toBe(1);
    expect(replayableSteps(steps).map((s) => s.id)).toEqual(["2", "4"]);
  });
});
