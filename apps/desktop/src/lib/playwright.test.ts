import { describe, expect, it } from "vitest";
import { toPlaywrightSpec } from "./playwright";

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
