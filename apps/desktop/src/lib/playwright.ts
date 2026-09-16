import type { Step } from "../store/agent";
import type { RecordedStep } from "./ipc";

/** A string as a single-quoted JS literal, the way Playwright writes them. */
function q(s: string): string {
  return `'${s.replace(/[\p{Cc}\u2028\u2029]/gu, "").replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** `{ name: 'Save', exact: true }` from already-formatted entries. */
function options(entries: string[]): string {
  return entries.length > 0 ? `, { ${entries.join(", ")} }` : "";
}

/**
 * One `role=button[name="Save"]` step of Dive's locator grammar as a
 * Playwright call. Attributes Playwright has no equivalent for are dropped
 * rather than guessed at, so the line that comes out still compiles.
 */
function roleCall(value: string): string {
  const open = value.indexOf("[");
  const role = (open < 0 ? value : value.slice(0, open)).trim();
  const attrs = open < 0 ? "" : value.slice(open);
  const entries: string[] = [];
  const name = /\[name="([^"]*)"\]/.exec(attrs) ?? /\[name='([^']*)'\]/.exec(attrs);
  if (name) entries.push(`name: ${q(name[1] ?? "")}`);
  if (attrs.includes("[exact]")) entries.push("exact: true");
  for (const flag of ["checked", "selected", "disabled", "pressed", "expanded"]) {
    if (attrs.includes(`[${flag}]`)) entries.push(`${flag}: true`);
  }
  const level = /\[level=(\d+)\]/.exec(attrs);
  if (level) entries.push(`level: ${level[1]}`);
  return `getByRole(${q(role)}${options(entries)})`;
}

/** A quoted value in the grammar means "match this exactly". */
function textCall(method: string, value: string): string {
  const exact = value.length > 1 && value.startsWith('"') && value.endsWith('"');
  const inner = exact ? value.slice(1, -1) : value;
  return `${method}(${q(inner)}${exact ? ", { exact: true }" : ""})`;
}

/** One `>>` step: a call to chain, or a modifier on the step before it. */
function part(raw: string): { call?: string; modifier?: string } | null {
  const token = raw.trim();
  if (!token) return null;
  const eq = token.indexOf("=");
  const prefix = eq < 0 ? "" : token.slice(0, eq).trim();
  const value = eq < 0 ? token : token.slice(eq + 1).trim();
  switch (prefix) {
    case "role":
      return { call: roleCall(value) };
    case "text":
      return { call: textCall("getByText", value) };
    case "label":
      return { call: textCall("getByLabel", value) };
    case "placeholder":
      return { call: textCall("getByPlaceholder", value) };
    case "alt":
      return { call: textCall("getByAltText", value) };
    case "title":
      return { call: textCall("getByTitle", value) };
    case "testid":
      return { call: `getByTestId(${q(value)})` };
    case "nth": {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n)) return null;
      return { modifier: n < 0 ? "last()" : `nth(${n})` };
    }
    case "visible":
      return value === "false" ? { modifier: "filter({ visible: false })" } : { modifier: "filter({ visible: true })" };
    case "css":
      return { call: `locator(${q(value)})` };
    default:
      // No prefix is CSS, which is what the grammar says the default is.
      return { call: `locator(${q(token)})` };
  }
}

/**
 * Dive's locator grammar as a chain of Playwright calls, so a step the model
 * addressed by locator exports as readable as one it addressed by ref.
 *
 * `null` when nothing usable comes out: the exporter then leaves the step
 * out rather than writing a line that would not run.
 */
export function toPlaywrightLocator(dive: string): string | null {
  const chain: string[] = [];
  for (const raw of dive.split(">>")) {
    const piece = part(raw);
    if (!piece) continue;
    if (piece.modifier) {
      if (chain.length === 0) return null;
      chain.push(piece.modifier);
    } else if (piece.call) {
      chain.push(piece.call);
    }
  }
  return chain.length > 0 ? chain.join(".") : null;
}

/** How a step addressed its element, in Playwright's words. */
function locatorOf(step: Step, input: Record<string, unknown>): string | null {
  // A ref was resolved to an accessible name by the host when it ran, which
  // is better evidence than anything recoverable now.
  if (step.locator) return step.locator;
  const written = input["locator"];
  return typeof written === "string" ? toPlaywrightLocator(written) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Turn the agent's executed steps into a Playwright test. Pure for tests.
 *
 * Only steps that changed the page are written out: a run's reads are how
 * the agent found its way, not part of the flow a test has to repeat. A step
 * that failed is left out too -- the test asserts the path that worked.
 */
export function toPlaywrightSpec(steps: Step[], startUrl: string | undefined, title = "recorded flow"): string {
  const body: string[] = [];
  // The last address the flow reached is what the test can check at the end.
  let lastUrl = startUrl;
  for (const s of steps) {
    if (s.error) continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(s.input) as Record<string, unknown>;
    } catch {
      // A call we cannot read the arguments of is one we cannot replay.
    }
    const at = locatorOf(s, input);
    const on = at ? `page.${at}` : null;
    switch (s.name) {
      case "page_click":
        if (on) body.push(`await ${on}.click();`);
        break;
      case "page_hover":
        if (on) body.push(`await ${on}.hover();`);
        break;
      case "page_type": {
        if (!on) break;
        body.push(`await ${on}.fill(${JSON.stringify(str(input["text"]))});`);
        if (input["submit"] === true) body.push(`await ${on}.press("Enter");`);
        break;
      }
      case "page_fill_form": {
        const fields = Array.isArray(input["fields"]) ? (input["fields"] as Record<string, unknown>[]) : [];
        let last: string | null = null;
        for (const field of fields) {
          const where = typeof field["locator"] === "string" ? toPlaywrightLocator(field["locator"]) : null;
          if (!where) continue;
          last = `page.${where}`;
          body.push(`await ${last}.fill(${JSON.stringify(str(field["value"]))});`);
        }
        if (input["submit"] === true && last) body.push(`await ${last}.press("Enter");`);
        break;
      }
      case "page_select": {
        if (!on) break;
        const by = str(input["label"]) ? `{ label: ${JSON.stringify(str(input["label"]))} }` : JSON.stringify(str(input["value"]));
        body.push(`await ${on}.selectOption(${by});`);
        break;
      }
      case "page_press": {
        const key = str(input["key"]);
        if (!key) break;
        const mods = Array.isArray(input["modifiers"]) ? (input["modifiers"] as unknown[]).filter((m): m is string => typeof m === "string") : [];
        const combo = JSON.stringify([...mods, key].join("+"));
        body.push(on ? `await ${on}.press(${combo});` : `await page.keyboard.press(${combo});`);
        break;
      }
      case "page_upload": {
        const paths = Array.isArray(input["paths"]) ? (input["paths"] as unknown[]).filter((p): p is string => typeof p === "string") : [];
        if (on && paths.length > 0) body.push(`await ${on}.setInputFiles(${JSON.stringify(paths.length === 1 ? paths[0] : paths)});`);
        break;
      }
      case "page_drag": {
        const from = typeof input["from"] === "string" ? toPlaywrightLocator(input["from"]) : null;
        const to = typeof input["to"] === "string" ? toPlaywrightLocator(input["to"]) : null;
        if (from && to) body.push(`await page.${from}.dragTo(page.${to});`);
        break;
      }
      case "page_scroll": {
        const dx = typeof input["delta_x"] === "number" ? input["delta_x"] : 0;
        const dy = typeof input["delta_y"] === "number" ? input["delta_y"] : 0;
        body.push(`await page.mouse.wheel(${dx}, ${dy});`);
        break;
      }
      case "page_resize": {
        const w = input["width"];
        const h = input["height"];
        if (typeof w === "number" && typeof h === "number") body.push(`await page.setViewportSize({ width: ${w}, height: ${h} });`);
        break;
      }
      case "page_wait_for": {
        // A wait is where the agent knew what had to be true, so it makes the
        // best assertion in the test -- better than the sleep a naive
        // recording would leave behind.
        const text = str(input["text"]);
        const url = str(input["url_includes"]);
        if (on) body.push(`await expect(${on}).toBeVisible();`);
        else if (text) body.push(`await expect(page.getByText(${q(text)})).toBeVisible();`);
        if (url) body.push(`await page.waitForURL(${JSON.stringify(`**${url}**`)});`);
        break;
      }
      case "tab_navigate": {
        const url = str(input["url"]);
        if (!url) break;
        body.push(`await page.goto(${JSON.stringify(url)});`);
        lastUrl = url;
        break;
      }
      default:
        break;
    }
  }
  const lines = ['import { test, expect } from "@playwright/test";', "", `test(${JSON.stringify(title)}, async ({ page }) => {`];
  if (startUrl) lines.push(`  await page.goto(${JSON.stringify(startUrl)});`);
  lines.push(...body.map((line) => `  ${line}`));
  lines.push(`  await expect(page).toHaveURL(${lastUrl ? JSON.stringify(lastUrl) : "/./"});`, "});", "");
  return lines.join("\n");
}

/** Steps a test can actually replay; the count the export offers to write. */
export function replayableSteps(steps: Step[]): Step[] {
  return steps.filter((s) => s.action && !s.error && s.summary !== undefined);
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
