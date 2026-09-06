/**
 * The injected locator engine, exercised against a DOM.
 *
 * These are the rules that decide which element an agent's `page_click`
 * lands on, so they are tested by behaviour rather than by asserting on the
 * script's text.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildInjected, hasUnfilledPlaceholder, INJECTABLE } from "./injected";

/** What the engine returns for a resolved element. */
interface Found {
  ok: true;
  x: number;
  y: number;
  width: number;
  height: number;
  role: string;
  name: string;
  tag: string;
  count: number;
}
interface Failed {
  error: "invalid" | "not_found" | "not_visible" | "not_enabled" | "not_editable";
  reason?: string;
}
type Result = Found | Failed;

interface ElementSummary {
  role: string;
  name: string;
  tag: string;
  locator: string;
  enabled: boolean;
  editable: boolean;
  value: string | null;
}

interface Locator {
  version: number;
  point(selector: string): Result;
  focus(selector: string): Result;
  matches(selector: string): { ok: true; count: number } | Failed;
  all(selector: string, limit?: number): { ok: true; matches: Found[] } | Failed;
  resolve(selector: string): Result;
  hold(selector: string): Result;
  elements(limit?: number): { ok: true; elements: ElementSummary[]; truncated: boolean } | Failed;
  page(textLimit?: number): Record<string, unknown> | Failed;
}

declare global {
  interface Window {
    __diveLocator?: Locator;
    __divePicker?: {
      version: number;
      start(): boolean;
      cancel(): boolean;
      setStyle(property: string, value: string): { ok?: true; error?: string; changes?: number };
      revertStyles(): { ok?: true; error?: string; reverted?: number };
      report():
        | { ok: true; element: Record<string, unknown>; styleChanges: Record<string, unknown>[] }
        | { error: string };
    };
    __diveHeld?: globalThis.Element;
  }
}

/**
 * jsdom lays nothing out, so every rect is zero and the visibility check
 * would reject the whole document. Give elements a size unless the fixture
 * marks them collapsed with `data-rect="0"`, and stub the scroll the engine
 * performs before reporting a point.
 */
function stubLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const collapsed = this.getAttribute("data-rect") === "0";
    const width = collapsed ? 0 : 100;
    const height = collapsed ? 0 : 20;
    return {
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      width,
      height,
      right: 10 + width,
      bottom: 20 + height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Element.prototype.scrollIntoView = function (): void {
    /* jsdom does not lay out; nothing to scroll. */
  };
}

function install(html: string): Locator {
  document.body.innerHTML = html;
  delete window.__diveLocator;
  eval(buildInjected("locator.js", { __MAX_CANDIDATES__: "5000" }));
  const engine = window.__diveLocator;
  if (!engine) throw new Error("the locator engine did not install");
  return engine;
}

function found(result: Result): Found {
  if ("error" in result) throw new Error(`expected a match, got ${JSON.stringify(result)}`);
  return result;
}

beforeEach(() => {
  stubLayout();
});

describe("script composition", () => {
  it("resolves includes and leaves no placeholders", () => {
    const script = buildInjected("locator.js", { __MAX_CANDIDATES__: "10" });
    expect(script).toContain("const roleOf =");
    expect(script).toContain("const isEditable =");
    expect(script).not.toContain("@dive-include");
    expect(hasUnfilledPlaceholder(script)).toBe(false);
  });

  it("declares a shared fragment once even when two includes pull it in", () => {
    const script = buildInjected("picker.js", { __NONCE__: '"n"', __BINDING__: "__diveTest" });
    expect(script.match(/const roleOf =/g)).toHaveLength(1);
    expect(script.match(/const isVisible =/g)).toHaveLength(1);
    expect(script.match(/const cssPathOf =/g)).toHaveLength(1);
  });

  it("compiles every composed script, wrapped so a re-run cannot redeclare a const", () => {
    for (const name of INJECTABLE) {
      const script = buildInjected(name, {
        __MAX_CANDIDATES__: "10",
        __NONCE__: '"n"',
        __BINDING__: "__diveTest",
        __MAX_FIELD__: "10",
        __ROLE__: '"button"',
        __MARKDOWN_CAP__: "1000",
      });
      expect(script.startsWith("(function () {"), name).toBe(true);
      expect(script.trimEnd().endsWith("})()"), name).toBe(true);
      // The composed form is what the host evaluates, so it is the form
      // worth syntax-checking: fragments are not valid on their own.
      expect(() => new Function(script), name).not.toThrow();
    }
  });

  it("is idempotent: installing twice keeps one engine", () => {
    const first = install(`<button>Save</button>`);
    eval(buildInjected("locator.js", { __MAX_CANDIDATES__: "5000" }));
    expect(window.__diveLocator).toBe(first);
  });
});

describe("role=", () => {
  it("matches an implicit role and accessible name", () => {
    const engine = install(`<button id="save">Save changes</button><button>Cancel</button>`);
    const match = found(engine.point('role=button[name="Save changes"]'));
    expect(match.role).toBe("button");
    expect(match.tag).toBe("button");
    expect(match.count).toBe(1);
  });

  it("treats a bare name as a case-insensitive substring", () => {
    const engine = install(`<button>Save changes</button>`);
    expect(found(engine.point("role=button[name=save]")).count).toBe(1);
    expect(found(engine.point("role=button[name=SAVE CHANGES]")).count).toBe(1);
  });

  it("treats a quoted name as exact", () => {
    const engine = install(`<button>Save changes</button>`);
    expect(engine.point('role=button[name="Save"]')).toEqual({ error: "not_found" });
    expect(found(engine.point('role=button[name="Save changes"]')).count).toBe(1);
  });

  it("honours [exact] on an unquoted name", () => {
    const engine = install(`<button>Save changes</button>`);
    expect(engine.point("role=button[name=save][exact]")).toEqual({ error: "not_found" });
  });

  it("prefers an explicit role attribute over the tag", () => {
    const engine = install(`<div role="button" tabindex="0">Go</div>`);
    expect(found(engine.point("role=button")).tag).toBe("div");
  });

  it("resolves the accessible name from aria-label and aria-labelledby", () => {
    const engine = install(`
      <button aria-label="Close dialog"><svg></svg></button>
      <span id="lbl">Delete account</span>
      <button aria-labelledby="lbl"></button>
    `);
    expect(found(engine.point('role=button[name="Close dialog"]')).count).toBe(1);
    expect(found(engine.point('role=button[name="Delete account"]')).count).toBe(1);
  });

  it("filters on checked, selected and level", () => {
    const engine = install(`
      <input type="checkbox" aria-label="a" checked>
      <input type="checkbox" aria-label="b">
      <h2>Title two</h2><h3>Title three</h3>
    `);
    expect(found(engine.point("role=checkbox[checked]")).name).toBe("a");
    expect(found(engine.point("role=checkbox[checked=false]")).name).toBe("b");
    expect(found(engine.point("role=heading[level=3]")).name).toBe("Title three");
  });

  it("filters on disabled in both directions", () => {
    const engine = install(`<button disabled>Off</button><button>On</button>`);
    expect(found(engine.resolve("role=button[disabled]")).name).toBe("Off");
    expect(found(engine.resolve("role=button[disabled=false]")).name).toBe("On");
  });

  it("rejects a role with unparseable filters", () => {
    const engine = install(`<button>Save</button>`);
    const result = engine.point("role=button[name=") as Failed;
    expect(result.error).toBe("invalid");
    expect(result.reason).toContain("role filters");
  });

  it("rejects role= with no role name", () => {
    const engine = install(`<button>Save</button>`);
    expect((engine.point("role=[name=x]") as Failed).error).toBe("invalid");
  });
});

describe("text=", () => {
  it("matches a substring, case-insensitively, ignoring extra whitespace", () => {
    const engine = install(`<p>Continue   to checkout</p>`);
    expect(found(engine.point("text=continue to")).tag).toBe("p");
  });

  it("matches exactly when quoted", () => {
    const engine = install(`<p>Continue to checkout</p>`);
    expect(engine.point('text="Continue"')).toEqual({ error: "not_found" });
    expect(found(engine.point('text="Continue to checkout"')).tag).toBe("p");
  });

  it("prefers the innermost element carrying the text", () => {
    const engine = install(`<div><section><span>Delete</span></section></div>`);
    expect(found(engine.point("text=Delete")).tag).toBe("span");
  });

  it("does not treat >> inside quotes as a step separator", () => {
    const engine = install(`<p>a &gt;&gt; b</p>`);
    expect(found(engine.point('text="a >> b"')).tag).toBe("p");
  });
});

describe("attribute engines", () => {
  it("finds by test id, placeholder, alt and title", () => {
    const engine = install(`
      <button data-testid="submit">Go</button>
      <input placeholder="Search issues">
      <img alt="Company logo">
      <a href="#" title="Close panel">x</a>
    `);
    expect(found(engine.point("testid=submit")).tag).toBe("button");
    expect(found(engine.point("placeholder=Search issues")).tag).toBe("input");
    expect(found(engine.resolve("alt=Company logo")).tag).toBe("img");
    expect(found(engine.point("title=Close panel")).tag).toBe("a");
  });

  it("finds a form control by its label text", () => {
    const engine = install(`<label for="e">Email address</label><input id="e">`);
    expect(found(engine.point("label=Email address")).tag).toBe("input");
  });

  it("treats an unprefixed selector as CSS", () => {
    const engine = install(`<div class="card"><button>Go</button></div>`);
    expect(found(engine.point(".card > button")).tag).toBe("button");
    expect(found(engine.point("css=.card")).tag).toBe("div");
  });

  it("reports an invalid CSS selector rather than throwing", () => {
    const engine = install(`<div></div>`);
    const result = engine.point("css=[[[") as Failed;
    expect(result.error).toBe("invalid");
    expect(result.reason).toContain("valid CSS selector");
  });
});

describe("chaining and indexing", () => {
  it("scopes each step inside the previous match", () => {
    const engine = install(`
      <div role="dialog"><button>Delete</button></div>
      <div><button>Delete</button></div>
    `);
    expect(found(engine.point("role=dialog >> text=Delete")).count).toBe(1);
    // Unscoped, the same text matches in both containers.
    expect(engine.matches("text=Delete")).toEqual({ ok: true, count: 2 });
  });

  it("picks a single match with nth=, counting from the end for negatives", () => {
    const engine = install(`<ul><li>one</li><li>two</li><li>three</li></ul>`);
    expect(found(engine.point("css=li >> nth=0")).name).toBe("one");
    expect(found(engine.point("css=li >> nth=-1")).name).toBe("three");
    expect(engine.point("css=li >> nth=9")).toEqual({ error: "not_found" });
  });

  it("rejects a non-integer nth", () => {
    const engine = install(`<ul><li>one</li></ul>`);
    const result = engine.point("css=li >> nth=first") as Failed;
    expect(result.error).toBe("invalid");
    expect(result.reason).toContain("integer");
  });

  it("filters on visibility", () => {
    const engine = install(`
      <button style="display:none">Hidden</button>
      <button>Shown</button>
    `);
    expect(found(engine.point("css=button >> visible=true")).name).toBe("Shown");
    expect(found(engine.resolve("css=button >> visible=false")).name).toBe("Hidden");
  });

  it("deduplicates elements reached through more than one scope", () => {
    const engine = install(`<div class="a b"><button>Go</button></div>`);
    expect(engine.matches("css=.a, .b >> css=button")).toEqual({ ok: true, count: 1 });
  });
});

describe("actionability", () => {
  it("separates not-found from not-visible and not-enabled", () => {
    const engine = install(`
      <button style="visibility:hidden">Invisible</button>
      <button data-rect="0">Collapsed</button>
      <button disabled>Disabled</button>
      <button aria-disabled="true">Aria disabled</button>
    `);
    expect(engine.point("text=Nothing here")).toEqual({ error: "not_found" });
    expect(engine.point("text=Invisible")).toEqual({ error: "not_visible" });
    expect(engine.point("text=Collapsed")).toEqual({ error: "not_visible" });
    expect(engine.point("text=Disabled")).toEqual({ error: "not_enabled" });
    expect(engine.point("text=Aria disabled")).toEqual({ error: "not_enabled" });
  });

  it("treats a control inside a disabled fieldset as disabled", () => {
    const engine = install(`<fieldset disabled><button>Inside</button></fieldset>`);
    expect(engine.point("text=Inside")).toEqual({ error: "not_enabled" });
  });

  it("reports the centre of the element in CSS pixels", () => {
    const engine = install(`<button>Save</button>`);
    const match = found(engine.point("text=Save"));
    // stubLayout puts every box at (10,20) sized 100x20.
    expect([match.x, match.y]).toEqual([60, 30]);
  });

  it("resolves without actionability so a hidden element can still be described", () => {
    const engine = install(`<button style="display:none">Hidden</button>`);
    expect(found(engine.resolve("text=Hidden")).name).toBe("Hidden");
  });

  it("reports how many elements matched so an ambiguous locator is visible", () => {
    const engine = install(`<button>Go</button><button>Go</button>`);
    expect(found(engine.point("text=Go")).count).toBe(2);
  });
});

describe("focus", () => {
  it("focuses a text field and reports its point", () => {
    const engine = install(`<input aria-label="Email">`);
    expect(found(engine.focus("label=Email")).tag).toBe("input");
    expect(document.activeElement?.tagName).toBe("INPUT");
  });

  it("accepts a contenteditable element", () => {
    // jsdom leaves `isContentEditable` undefined, so the attribute path is
    // the one under test here as well as the fallback in a real page.
    const engine = install(`<div contenteditable="true" role="textbox">note</div>`);
    expect(found(engine.focus("role=textbox")).tag).toBe("div");
  });

  it("refuses a non-editable target, a readonly field and a checkbox", () => {
    const engine = install(`
      <p>Just text</p>
      <input aria-label="Locked" readonly>
      <input type="checkbox" aria-label="Toggle">
    `);
    expect(engine.focus("text=Just text")).toEqual({ error: "not_editable" });
    // A locked field has to report that it is locked. Reporting "not found"
    // would send the caller looking for a different locator.
    expect(engine.focus("label=Locked")).toEqual({ error: "not_editable" });
    expect(engine.focus("role=checkbox")).toEqual({ error: "not_editable" });
  });
});

describe("shadow DOM", () => {
  it("pierces an open shadow root", () => {
    const engine = install(`<div id="host"></div>`);
    const host = document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<button>Inner</button>`;
    expect(found(engine.point("role=button")).name).toBe("Inner");
  });
});

describe("all and hold", () => {
  it("describes each match for disambiguation", () => {
    const engine = install(`<button>One</button><button>Two</button>`);
    const result = engine.all("role=button", 5);
    if ("error" in result) throw new Error(result.error);
    expect(result.matches.map((m) => m.name)).toEqual(["One", "Two"]);
  });

  it("sets the node aside for a follow-up expression", () => {
    const engine = install(`<button id="target">Go</button>`);
    expect(found(engine.hold("text=Go")).tag).toBe("button");
    expect(window.__diveHeld).toBe(document.getElementById("target"));
  });

  it("returns zero rather than an error when nothing matches", () => {
    const engine = install(`<div></div>`);
    expect(engine.matches("text=absent")).toEqual({ ok: true, count: 0 });
  });

  it("rejects an empty locator", () => {
    const engine = install(`<div></div>`);
    expect((engine.point("   ") as Failed).error).toBe("invalid");
  });
});

describe("elements", () => {
  function listed(html: string, limit?: number): ElementSummary[] {
    const engine = install(html);
    const result = engine.elements(limit);
    if ("error" in result) throw new Error(result.error);
    return result.elements;
  }

  it("gives every interactive element a locator that resolves to it", () => {
    const html = `
      <button>Save</button>
      <a href="/help">Help</a>
      <input aria-label="Email">
      <select aria-label="Country"><option>NZ</option></select>
    `;
    const engine = install(html);
    const result = engine.elements();
    if ("error" in result) throw new Error(result.error);
    expect(result.elements.map((e) => e.role)).toEqual([
      "button",
      "link",
      "textbox",
      "combobox",
    ]);
    // The locator each entry advertises has to actually find that entry.
    for (const element of result.elements) {
      expect(engine.matches(element.locator), element.locator).toEqual({ ok: true, count: 1 });
    }
  });

  it("disambiguates repeated elements with nth so each locator is unique", () => {
    const engine = install(`<button>Go</button><button>Go</button><button>Go</button>`);
    const result = engine.elements();
    if ("error" in result) throw new Error(result.error);
    expect(result.elements.map((e) => e.locator)).toEqual([
      'role=button[name="Go"] >> nth=0',
      'role=button[name="Go"] >> nth=1',
      'role=button[name="Go"] >> nth=2',
    ]);
    for (const element of result.elements) {
      expect(engine.matches(element.locator), element.locator).toEqual({ ok: true, count: 1 });
    }
  });

  it("skips what cannot be acted on and reports what is disabled", () => {
    const elements = listed(`
      <button style="display:none">Hidden</button>
      <button disabled>Disabled</button>
      <div role="presentation" tabindex="0">Decorative</div>
      <button>Real</button>
    `);
    expect(elements.map((e) => e.name)).toEqual(["Disabled", "Real"]);
    expect(elements[0]?.enabled).toBe(false);
    expect(elements[1]?.enabled).toBe(true);
  });

  it("reports the current value of a field so a form's state is visible", () => {
    const elements = listed(`<input aria-label="Email" value="a@b.dev">`);
    expect(elements[0]).toMatchObject({ editable: true, value: "a@b.dev" });
  });

  it("caps the list and says when it truncated", () => {
    const engine = install(Array.from({ length: 12 }, (_, i) => `<button>b${i}</button>`).join(""));
    const result = engine.elements(5);
    if ("error" in result) throw new Error(result.error);
    expect(result.elements).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it("reports the page state a caller needs to know where it is", () => {
    const engine = install(`<h1>Dashboard</h1>`);
    const page = engine.page(100) as Record<string, unknown>;
    expect(page.ok).toBe(true);
    expect(page.title).toBe(document.title);
    expect(page.ready_state).toBe(document.readyState);
    expect(page.viewport).toMatchObject({ width: window.innerWidth });
    expect(String(page.visible_text).length).toBeLessThanOrEqual(100);
  });
});

describe("picker", () => {
  function installPicker(html: string) {
    document.body.innerHTML = html;
    delete window.__divePicker;
    const sent: { kind: string; payload: unknown }[] = [];
    (window as unknown as Record<string, unknown>).__diveTest = (raw: string) => {
      sent.push(JSON.parse(raw));
    };
    eval(buildInjected("picker.js", { __NONCE__: '"n1"', __BINDING__: "__diveTest" }));
    // Direct eval installs this global at runtime, which TypeScript cannot
    // infer after the explicit delete above. Reflect.get widens it back to
    // the declared optional picker contract before the runtime assertion.
    const picker = Reflect.get(window, "__divePicker") as Window["__divePicker"];
    if (!picker) throw new Error("the picker did not install");
    return { picker, sent };
  }

  it("cancels cleanly when it was never started", () => {
    const { picker } = installPicker(`<button>Go</button>`);
    expect(picker.start()).toBe(true);
    expect(picker.cancel()).toBe(true);
    expect(picker.cancel()).toBe(false);
  });

  it("refuses style edits before anything is picked", () => {
    const { picker } = installPicker(`<button>Go</button>`);
    expect(picker.setStyle("color", "red")).toEqual({ error: "nothing_picked" });
    expect(picker.report()).toEqual({ error: "nothing_picked" });
  });

  it("reports a style experiment as a before/after diff", () => {
    const { picker } = installPicker(`<button id="b" style="padding: 8px">Go</button>`);
    const button = document.getElementById("b")!;
    // jsdom's elementFromPoint always returns null, so stub the hit test and
    // then drive a real click the way a person would.
    document.elementFromPoint = () => button;
    picker.start();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(picker.setStyle("padding", "12px")).toMatchObject({ ok: true, changes: 1 });
    const report = picker.report();
    if ("error" in report) throw new Error(report.error);
    expect(report.styleChanges).toHaveLength(1);
    expect(report.styleChanges[0]).toMatchObject({
      property: "padding",
      previousValue: "8px",
      value: "12px",
    });
    expect(button.style.padding).toBe("12px");

    expect(picker.revertStyles()).toMatchObject({ ok: true, reverted: 1 });
    expect(button.style.padding).toBe("8px");
  });

  it("captures a locator, a CSS path and the source location for a pick", () => {
    const { picker, sent } = installPicker(
      `<main><button id="save" data-testid="save">Save</button></main>`,
    );
    const button = document.getElementById("save")!;
    // Fake the fiber React would attach, including the dev-only source.
    (button as unknown as Record<string, unknown>)["__reactFiber$abc"] = {
      type: function SubmitButton() {},
      _debugSource: { fileName: "/src/components/Form.tsx", lineNumber: 42, columnNumber: 7 },
      return: null,
    };
    document.elementFromPoint = () => button;
    picker.start();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const picked = sent.find((m) => m.kind === "picked");
    expect(picked).toBeDefined();
    const payload = picked!.payload as Record<string, unknown>;
    expect(payload.componentName).toBe("SubmitButton");
    expect(payload.source).toMatchObject({
      fileName: "/src/components/Form.tsx",
      lineNumber: 42,
    });
    expect(payload.locator).toBe('role=button[name="Save"]');
    expect(payload.selector).toBe("#save");
    // jsdom resolves few properties and no shorthands, so assert on one it
    // does report rather than on the shape of a real Chromium computation.
    expect(payload.styles).toContain("display:");
    expect(payload.htmlPreview).toContain("data-testid");
  });

  it("falls back to the DOM when the page is not React", () => {
    const { picker, sent } = installPicker(`<div class="card">Plain</div>`);
    const div = document.querySelector(".card")!;
    document.elementFromPoint = () => div;
    picker.start();
    div.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const payload = sent.find((m) => m.kind === "picked")!.payload as Record<string, unknown>;
    expect(payload.componentName).toBeNull();
    expect(payload.source).toBeNull();
    // No role or name, so the locator degrades to a CSS path rather than lying.
    expect(String(payload.locator)).toMatch(/^css=/);
  });

  it("reports Escape as a cancellation", () => {
    const { picker, sent } = installPicker(`<button>Go</button>`);
    picker.start();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sent.some((m) => m.kind === "cancelled")).toBe(true);
  });
});
