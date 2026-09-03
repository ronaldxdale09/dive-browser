import type { Step } from "../store/agent";
import type { RecordedStep } from "./ipc";

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

/** Mirror of the Rust locator builder so recorded steps export the same way. */
export function playwrightLocator(role: string, name: string): string {
  const r = role === "searchbox" ? "textbox" : role || "generic";
  if (!name) return `getByRole('${r}')`;
  const escaped = name.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  return `getByRole('${r}', { name: '${escaped}' })`;
}

/** Recorded interactions in the same shape as agent steps. */
export function recordedToSteps(recorded: RecordedStep[]): Step[] {
  return recorded.map((r, i) => {
    const locator = r.role ? playwrightLocator(r.role, r.name) : null;
    if (r.kind === "navigate") return { id: `r${i}`, name: "tab_navigate", input: JSON.stringify({ url: r.value }), action: true, locator: null };
    if (r.kind === "type") return { id: `r${i}`, name: "page_type", input: JSON.stringify({ text: r.value }), action: true, locator };
    return { id: `r${i}`, name: "page_click", input: "{}", action: true, locator };
  });
}
