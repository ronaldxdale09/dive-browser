import type { Step } from "../store/agent";

/** Turn the agent's executed steps into a Playwright test. Pure for tests. */
export function toPlaywrightSpec(steps: Step[], startUrl: string | undefined, title = "recorded flow"): string {
  const lines: string[] = [];
  lines.push('import { test, expect } from "@playwright/test";', "", `test(${JSON.stringify(title)}, async ({ page }) => {`);
  if (startUrl) lines.push(`  await page.goto(${JSON.stringify(startUrl)});`);
  for (const s of steps) {
    if (s.error) continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(s.input) as Record<string, unknown>;
    } catch {
      // keep empty
    }
    switch (s.name) {
      case "page_click":
        if (s.locator) lines.push(`  await page.${s.locator}.click();`);
        break;
      case "page_type": {
        const text = typeof input["text"] === "string" ? input["text"] : "";
        if (s.locator) {
          lines.push(`  await page.${s.locator}.fill(${JSON.stringify(text)});`);
          if (input["submit"] === true) lines.push(`  await page.${s.locator}.press("Enter");`);
        }
        break;
      }
      case "tab_navigate":
        if (typeof input["url"] === "string") lines.push(`  await page.goto(${JSON.stringify(input["url"])});`);
        break;
      default:
        break;
    }
  }
  lines.push("  await expect(page).toHaveURL(/./);", "});", "");
  return lines.join("\n");
}
