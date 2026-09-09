/**
 * Loads the JavaScript Dive injects into pages, the same way the Rust host
 * does in `src-tauri/src/pagescript.rs`.
 *
 * The scripts are the locator engine, the flow recorder and the element
 * picker: a few hundred lines of DOM traversal and selector parsing that
 * decide whether an agent clicks the right button. Assertions on the script
 * *text* in Rust cannot catch a wrong `:nth-of-type` index or a role that
 * resolves to the wrong element, so the same sources are composed here and
 * exercised against a DOM in `injected.test.ts`.
 *
 * Test-only: nothing in the chrome imports this, so it lives under `test/`
 * rather than `lib/`, and the include graph has exactly one reader here.
 */

import actionability from "../../src-tauri/src/inject/actionability.js?raw";
import component from "../../src-tauri/src/inject/component.js?raw";
import cssPath from "../../src-tauri/src/inject/css-path.js?raw";
import locator from "../../src-tauri/src/inject/locator.js?raw";
import markdown from "../../src-tauri/src/inject/markdown.js?raw";
import webapp from "../../src-tauri/src/inject/webapp.js?raw";
import webappIcon from "../../src-tauri/src/inject/webapp-icon.js?raw";
import picker from "../../src-tauri/src/inject/picker.js?raw";
import reactContext from "../../src-tauri/src/inject/react-context.js?raw";
import recorder from "../../src-tauri/src/inject/recorder.js?raw";
import roleName from "../../src-tauri/src/inject/role-name.js?raw";

/** Every injectable fragment, by file name. Mirrors `FRAGMENTS` in Rust. */
const FRAGMENTS: Record<string, string> = {
  "role-name.js": roleName,
  "actionability.js": actionability,
  "react-context.js": reactContext,
  "css-path.js": cssPath,
  "locator.js": locator,
  "recorder.js": recorder,
  "picker.js": picker,
  "component.js": component,
  "markdown.js": markdown,
  "webapp.js": webapp,
  "webapp-icon.js": webappIcon,
};

const DIRECTIVE = "// @dive-include ";
const MAX_DEPTH = 8;

function fragment(name: string): string {
  const source = FRAGMENTS[name];
  if (source === undefined) throw new Error(`no injectable script named ${name}`);
  return source;
}

function collect(name: string, depth: number, seen: string[], out: string[]): void {
  if (depth >= MAX_DEPTH) throw new Error(`@dive-include nested too deep at ${name}`);
  const source = fragment(name);
  for (const line of source.split("\n")) {
    const directive = line.trim();
    if (!directive.startsWith(DIRECTIVE)) continue;
    const dependency = directive.slice(DIRECTIVE.length).trim();
    fragment(dependency);
    if (seen.includes(dependency)) continue;
    seen.push(dependency);
    collect(dependency, depth + 1, seen, out);
  }
  for (const line of source.split("\n")) {
    if (line.trim().startsWith(DIRECTIVE)) continue;
    out.push(line);
  }
}

/** Whether any `__UPPER_SNAKE__` token survived substitution. */
export function hasUnfilledPlaceholder(body: string): boolean {
  return body
    .split("__")
    .filter((_, index) => index % 2 === 1)
    .some((token) => token.length > 0 && /^[A-Z0-9_]+$/.test(token));
}

/**
 * Build the script for `entry` with its includes resolved and its
 * placeholders substituted. Values are inserted verbatim, so anything from a
 * page has to arrive already JSON-encoded.
 */
export function buildInjected(entry: string, values: Record<string, string> = {}): string {
  const lines: string[] = [];
  collect(entry, 0, [entry], lines);
  let body = lines.join("\n");
  for (const [placeholder, value] of Object.entries(values)) {
    body = body.split(placeholder).join(value);
  }
  if (hasUnfilledPlaceholder(body)) {
    throw new Error(`${entry} still has an unfilled __PLACEHOLDER__ token`);
  }
  return `(function () {\n"use strict";\n${body}})()`;
}

/** The fragment names, for tests that want to sweep all of them. */
export const INJECTABLE = Object.keys(FRAGMENTS);
