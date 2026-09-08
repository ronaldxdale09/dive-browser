import type { Step } from "../store/agent";
import type { RecordedStep } from "./ipc";

/** Turn the agent's executed steps into a Playwright test. Pure for tests. */
export function toPlaywrightSpec(steps: Step[], startUrl: string | undefined, title = "recorded flow"): string {
  const lines: string[] = [];
  lines.push('import { test, expect } from "@playwright/test";', "", `test(${JSON.stringify(title)}, async ({ page }) => {`);
  if (startUrl) lines.push(`  await page.goto(${JSON.stringify(startUrl)});`);
  // The last address the flow reached is what the test can check at the end.
  let lastUrl = startUrl;
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
        if (typeof input["url"] === "string") {
          lines.push(`  await page.goto(${JSON.stringify(input["url"])});`);
          lastUrl = input["url"];
        }
        break;
      default:
        break;
    }
  }
  lines.push(`  await expect(page).toHaveURL(${lastUrl ? JSON.stringify(lastUrl) : "/./"});`, "});", "");
  return lines.join("\n");
}

/** Mirror of the Rust locator builder so recorded steps export the same way. */
export function playwrightLocator(role: string, name: string): string {
  const r = role === "searchbox" ? "textbox" : role || "generic";
  if (!name) return `getByRole('${r}')`;
  const escaped = name
    .replace(/[\p{Cc}\u2028\u2029]/gu, "")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
  return `getByRole('${r}', { name: '${escaped}' })`;
}

/**
 * Recorded interactions in the same shape as agent steps. A navigation that
 * directly follows a click or typing is what that action caused (a link, a
 * submitted form), so it is not replayed as a `goto` of its own; a typed
 * address or the first step still is.
 */
export function recordedToSteps(recorded: RecordedStep[]): Step[] {
  // The engine reports one navigation more than once (the address change,
  // then the commit); a repeat of the same address right after is one step.
  const distinct = recorded.filter((r, i) => !(r.kind === "navigate" && i > 0 && recorded[i - 1]!.kind === "navigate" && recorded[i - 1]!.value === r.value));
  const own = distinct.filter((r, i) => !(r.kind === "navigate" && i > 0 && distinct[i - 1]!.kind !== "navigate"));
  return own.map((r, i) => {
    const locator = r.role ? playwrightLocator(r.role, r.name) : null;
    if (r.kind === "navigate") return { id: `r${i}`, name: "tab_navigate", input: JSON.stringify({ url: r.value }), action: true, locator: null };
    if (r.kind === "type") return { id: `r${i}`, name: "page_type", input: JSON.stringify({ text: r.value }), action: true, locator };
    return { id: `r${i}`, name: "page_click", input: "{}", action: true, locator };
  });
}
