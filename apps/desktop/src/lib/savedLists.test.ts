import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import credentialsSource from "../../src-tauri/src/inject/credentials.js?raw";
import formsSource from "../../src-tauri/src/inject/forms.js?raw";

// Both scripts run in the top frame only; the tests host them in an iframe.
const mainFrameOnly = /if \(window\.top !== window\) return;[^\n]*\n/;

type Page = Window & typeof globalThis & Record<string, unknown>;

/**
 * A page with the script installed. jsdom cannot make a trusted event, so
 * the scripts' trust checks are read as passed; and the closed shadow roots
 * they make are kept, since nothing else can reach into them.
 */
function install(source: string, binding: string) {
  const element = document.createElement("iframe");
  document.body.append(element);
  const page = element.contentWindow as Page;
  const sent: Record<string, unknown>[] = [];
  page[binding] = (payload: string) => sent.push(JSON.parse(payload));
  const roots: ShadowRoot[] = [];
  const attach = page.Element.prototype.attachShadow;
  page.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    roots.push(root);
    return root;
  };
  const script = source
    .replace(mainFrameOnly, "")
    .replaceAll("__NONCE__", '"n"')
    .replaceAll("__BINDING__", binding)
    .replaceAll("e.isTrusted", "true");
  // The frame's own classes, so `instanceof` and the prototype the script
  // takes its attachShadow from are the page's, as they are in a real tab.
  const globals = { window: page, document: page.document, Element: page.Element, Node: page.Node, HTMLInputElement: page.HTMLInputElement, HTMLFormElement: page.HTMLFormElement, Event: page.Event, MutationObserver: page.MutationObserver, getComputedStyle: page.getComputedStyle.bind(page), setTimeout, clearTimeout };
  new Function(...Object.keys(globals), script)(...Object.values(globals));
  return { page, sent, roots };
}

const key = (page: Page, target: Element, init: KeyboardEventInit) => target.dispatchEvent(new page.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("saved-login list", () => {
  function signIn() {
    const setup = install(credentialsSource, "__diveLogins");
    const { page } = setup;
    const form = page.document.createElement("form");
    form.innerHTML = '<input name="user" aria-describedby="hint"><input type="password">';
    page.document.body.append(form);
    // jsdom lays nothing out; the scripts only look at fields with a size.
    for (const input of form.querySelectorAll("input")) input.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    (page.__diveCredentialsOffer as (nonce: string, list: unknown[]) => void)("n", [
      { id: "c1", username: "dale" },
      { id: "c2", username: "eve" },
    ]);
    const user = form.querySelector("input")!;
    return { ...setup, user };
  }
  const region = (roots: ShadowRoot[]) => roots[0]!.querySelector('[role="status"]')!;
  const list = (roots: ShadowRoot[]) => roots[0]!.querySelector('[role="listbox"]') as HTMLElement;

  it("has its live region in the page before the list first opens, and says what it holds", () => {
    const { page, roots, user } = signIn();
    // Made with the answer that there is a choice, not with the first opening.
    expect(roots).toHaveLength(1);
    expect(region(roots).getAttribute("aria-live")).toBe("polite");
    expect(list(roots).style.display).toBe("none");
    user.dispatchEvent(new page.Event("pointerdown", { bubbles: true }));
    user.focus();
    expect(list(roots).style.display).toBe("block");
    expect(list(roots).getAttribute("aria-label")).toBe("Saved logins");
    vi.advanceTimersByTime(60);
    expect(region(roots).textContent).toBe("2 saved logins, use arrow keys");
    key(page, user, { key: "ArrowDown" });
    vi.advanceTimersByTime(60);
    expect(region(roots).textContent).toBe("dale, 1 of 2");
    key(page, user, { key: "ArrowUp" });
    vi.advanceTimersByTime(60);
    expect(region(roots).textContent).toBe("eve, 2 of 2");
  });

  it("comes back on Down Arrow after Escape, and leaves the page's own field alone", () => {
    const { page, roots, user } = signIn();
    const before = [...user.attributes].map((a) => `${a.name}=${a.value}`);
    user.dispatchEvent(new page.Event("pointerdown", { bubbles: true }));
    user.focus();
    key(page, user, { key: "Escape" });
    expect(list(roots).style.display).toBe("none");
    // Hidden, the region is still there to be heard.
    expect(roots[0]!.host.isConnected).toBe(true);
    key(page, user, { key: "ArrowDown", altKey: true });
    expect(list(roots).style.display).toBe("block");
    vi.advanceTimersByTime(60);
    expect(region(roots).textContent).toBe("2 saved logins, use arrow keys");
    expect([...user.attributes].map((a) => `${a.name}=${a.value}`)).toEqual(before);
  });
});

describe("form-entry list", () => {
  function field() {
    const setup = install(formsSource, "__diveForms");
    const { page } = setup;
    const input = page.document.createElement("input");
    input.name = "city";
    page.document.body.append(input);
    input.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    input.focus();
    input.value = "P";
    input.dispatchEvent(new page.Event("input", { bubbles: true }));
    vi.advanceTimersByTime(100);
    const query = setup.sent.find((p) => p["kind"] === "query")!;
    (page.__diveFormsOffer as (nonce: string, token: unknown, list: unknown[]) => void)("n", query["token"], ["Paris", "Perth"]);
    return { ...setup, input };
  }

  it("names its list and says what it holds and where the arrows are", () => {
    const { page, roots, input } = field();
    const root = roots[0]!;
    expect(root.querySelector('[role="listbox"]')!.getAttribute("aria-label")).toBe("Earlier entries for this field");
    vi.advanceTimersByTime(60);
    const region = root.querySelector('[role="status"]')!;
    expect(region.textContent).toBe("2 earlier entries, use arrow keys");
    key(page, input, { key: "ArrowDown" });
    vi.advanceTimersByTime(60);
    expect(region.textContent).toBe("Paris, 1 of 2");
  });

  it("no longer takes the page's own aria-activedescendant away when it closes", () => {
    const { page, input } = field();
    input.setAttribute("aria-activedescendant", "pages-own-option");
    key(page, input, { key: "Escape" });
    expect(input.getAttribute("aria-activedescendant")).toBe("pages-own-option");
  });
});
